import { loadEnv, ensureDbDir } from "./config/env.js";
import { logger } from "./logger.js";
import { Store } from "./core/store.js";
import { HttpClient, closeSharedDispatcher } from "./core/http.js";
import { runShutdown, type Signal } from "./core/shutdown.js";
import { Poller } from "./core/poller.js";
import { DiscordNotifier } from "./notify/discord.js";
import { startDashboard } from "./web/server.js";
import { closeSharedBrowser } from "./core/browser.js";
import { YahooAuctionsAdapter } from "./markets/yahooAuctions.js";
import { GrailedAdapter } from "./markets/grailed.js";
import { EbayAdapter } from "./markets/ebay.js";
import { MercariAdapter } from "./markets/mercari.js";
import { RakumaAdapter } from "./markets/rakuma.js";
import { ALL_MARKETS } from "./types.js";

async function main(): Promise<void> {
  const env = loadEnv();
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

  const dashboard = startDashboard(store, env.port, () => {
    const listings = store.recentListings(24 * 14);
    const deals = store.recentDeals(["all"], 1000);
    const byMarket = Object.fromEntries(
      ALL_MARKETS.map((m) => [
        m,
        listings.filter((l) => l.market === m).length,
      ]),
    );
    return `listings(14d): ${listings.length} · deals: ${deals.length} · markets: ${Object.entries(byMarket)
      .map(([m, c]) => `${m}:${c}`)
      .join(" ")}`;
  });

  await notifier.start();
  await dashboard.start();

  const shutdown = async (signal: Signal) => {
    await runShutdown(
      {
        stopPolling: () => poller.stop(),
        closeNotifier: () => notifier.stop(),
        closeDashboard: () => dashboard.stop(),
        closeBrowser: () => closeSharedBrowser().catch(() => {}),
        closeDispatcher: closeSharedDispatcher,
        closeStore: () => store.close(),
      },
      signal,
    );
    process.exit(0);
  };
  process.on("SIGINT", (sig) => void shutdown(sig as Signal));
  process.on("SIGTERM", (sig) => void shutdown(sig as Signal));

  poller.start();
  logger.info({ port: env.port, db: env.dbPath }, "swagscout running");
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
