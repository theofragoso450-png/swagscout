import { ensureDbDir, type Env } from "./config/env.js";
import { logger } from "./logger.js";
import { Store } from "./core/store.js";
import { catchUpPipeline, type RecomputeStats } from "./core/recompute.js";
import { startRetention } from "./core/retention.js";
import { startFxRefresh, fxStatusLabel, FX_SOURCE_URL } from "./core/fx.js";
import { HttpClient, closeSharedDispatcher } from "./core/http.js";
import { runShutdown, type ShutdownSteps, type Signal } from "./core/shutdown.js";
import { Poller } from "./core/poller.js";
import { DiscordNotifier } from "./notify/discord.js";
import { startDashboard } from "./web/server.js";
import { closeSharedBrowser } from "./core/browser.js";
import { YahooAuctionsAdapter } from "./markets/yahooAuctions.js";
import { GrailedAdapter } from "./markets/grailed.js";
import { EbayAdapter } from "./markets/ebay.js";
import { MercariAdapter } from "./markets/mercari.js";
import { RakumaAdapter } from "./markets/rakuma.js";

/**
 * The composition: env → store → adapters → notifier → FX → catch-up →
 * retention → poller → dashboard, plus the shutdown sequence that tears it back
 * down in dependency order.
 *
 * It lives here rather than in the entry point so the wiring can be exercised
 * as it ships: a test can boot the real thing against a temporary database and
 * run the real shutdown sequence, rather than replicating the ordering and
 * hoping it still matches. Signals and `process.exit` stay in index.ts — this
 * module never exits a process.
 */
export interface App {
  /** The port the dashboard actually bound (matters when `env.port` is 0). */
  port: number;
  /** The pipeline catch-up running in the background; resolves when it stops. */
  catchUp: Promise<RecomputeStats | undefined>;
  /** The shutdown sequence, in the order it runs. Exposed so a supervisor — or
   *  a test — can wrap a step without reimplementing the composition. */
  steps: ShutdownSteps;
  /** Run the shutdown sequence once. Resolves once everything is closed; it
   *  never exits the process, because that is the entry point's call to make. */
  shutdown(signal: Signal): Promise<void>;
}

/** Boot the whole app. Throws if the database cannot be opened or bound. */
export async function startApp(env: Env): Promise<App> {
  ensureDbDir(env);

  const store = new Store(env.dbPath);
  const http = new HttpClient(env.rateLimitRpm);

  const adapters = [
    new YahooAuctionsAdapter(http),
    new GrailedAdapter(http, env.playwrightExecutablePath),
    new EbayAdapter(http, env.ebayAppId, env.ebayCertId),
    new MercariAdapter(http, env.playwrightExecutablePath),
    new RakumaAdapter(http),
  ];

  const notifier = new DiscordNotifier(store, {
    token: env.discordToken,
    webhookUrl: env.discordWebhookUrl,
    allowedChannels: env.discordAllowedChannels,
  });

  // Daily finds digest — only meaningful with a bot client that can post.
  if (env.digestHour !== undefined && env.discordToken) {
    notifier.startDigest(env.digestHour);
  }

  // Live FX rates: restore the cached snapshot and refresh it when the cadence
  // says it is stale. FX_REFRESH_HOURS=0 pins the built-in static table.
  //
  // This must stay ABOVE the pipeline catch-up below. Restoring is synchronous,
  // and the catch-up rebuilds deals through the rules engine, which bakes USD
  // prices and reason prose at whatever rate is in force. Recomputing first
  // would stamp every rebuilt deal at the static rate while reads derive at the
  // live one — the drift this whole unit exists to remove.
  //
  // A failure streak is not a log-only event either: dollar labels drift
  // silently while it lasts, so it is worth telling the channels we alert to.
  startFxRefresh(store, {
    hours: env.fxRefreshHours,
    fetchJson: () => http.getJson(FX_SOURCE_URL),
    onDegraded: (info) => {
      void notifier.alertOperators(
        "FX rates are stale",
        `${info.consecutiveFailures} consecutive refresh failures (${info.reason}). ` +
          `Prices are still served from ${fxStatusLabel(env.fxRefreshHours)}, but dollar ` +
          `labels drift until a refresh succeeds.`,
      );
    },
  });

  // Pipeline catch-up: rows stored by an older extraction pipeline get their
  // brand/size/deal fields recomputed by the current one. Bump PIPELINE_VERSION
  // to trigger; a no-op when everything is current.
  //
  // Kicked off, not awaited: it works the backlog in bounded chunks and yields
  // between them, so a version bump converges in this one boot instead of ~11
  // restarts and the dashboard binds without waiting on it. FX is already in
  // force above — that is the rate the rebuilt prices are computed at.
  //
  // The abort belongs to the shutdown sequence below: the catch-up writes
  // through the store, so it is stopped (between chunks) before the store is
  // closed, not closed out from under.
  const catchUpAbort = new AbortController();
  const catchUp = catchUpPipeline(
    store,
    { compRoundUsd: env.compRoundUsd },
    { signal: catchUpAbort.signal },
  ).catch((err) => {
    logger.error({ err }, "pipeline catch-up failed");
    return undefined;
  });

  // Nightly retention: prune listings (and their deals) past the window.
  // RETENTION_DAYS=0 disables; hourlies tick with boot catch-up.
  if (env.retentionDays > 0) {
    startRetention(store, { days: env.retentionDays });
  }

  const poller = new Poller(
    store,
    adapters,
    {
      pollSeconds: env.pollSeconds,
      compRoundUsd: env.compRoundUsd,
      watchKeys: env.watchKeys,
    },
    async (results) => {
      await notifier.sendDeals(results);
      const totals = results.reduce(
        (acc, r) => ({
          fetched: acc.fetched + r.fetched,
          new: acc.new + r.newListings,
          deals: acc.deals + r.deals.length,
        }),
        { fetched: 0, new: 0, deals: 0 },
      );
      logger.info(totals, "poll round complete");
    },
  );

  const dashboard = startDashboard(store, env.port, () => statsLine(store, env));

  // Binding is the last step that can fail, and the store is already open by
  // then: without this, an occupied port would leave the database locked and the
  // process alive on a Discord client nobody can reach. The shared dispatcher is
  // deliberately left alone — its close is one-way and module-level, so a retry
  // in the same process would leave every later request throwing.
  let port: number;
  try {
    await notifier.start();
    port = await dashboard.start();
  } catch (err) {
    catchUpAbort.abort();
    await catchUp;
    await notifier.stop().catch(() => {});
    await closeSharedBrowser().catch(() => {});
    store.close();
    throw err;
  }

  const steps: ShutdownSteps = {
    stopPolling: () => poller.stop(),
    stopCatchUp: async () => {
      catchUpAbort.abort();
      await catchUp;
    },
    closeNotifier: () => notifier.stop(),
    closeDashboard: () => dashboard.stop(),
    closeBrowser: () => closeSharedBrowser().catch(() => {}),
    closeDispatcher: closeSharedDispatcher,
    closeStore: () => store.close(),
  };

  poller.start();
  logger.info({ port, db: env.dbPath }, "swagscout running");

  return {
    port,
    catchUp,
    steps,
    shutdown: (signal: Signal) => runShutdown(steps, signal),
  };
}

/** The dashboard's summary stats line. Per-market health is a separate wire
 *  field (rendered as interactive chips client-side) — embedding the markers
 *  here too made the header show markets twice. */
function statsLine(store: Store, env: Env): string {
  const listings = store.recentListings(24 * 14);
  const deals = store.recentDeals(["all"], 1000);
  const fmt = (n: number) => n.toLocaleString("en-US");
  return `${fmt(listings.length)} listings · ${fmt(deals.length)} deals · last 14d · FX ${fxStatusLabel(env.fxRefreshHours)}`;
}
