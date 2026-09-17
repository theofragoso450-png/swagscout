import { loadEnv, ensureDbDir } from "./config/env.js";
import { logger } from "./logger.js";
import { Store } from "./core/store.js";
import { HttpClient, closeSharedDispatcher } from "./core/http.js";
import { Poller } from "./core/poller.js";
import { YahooAuctionsAdapter } from "./markets/yahooAuctions.js";
import { GrailedAdapter } from "./markets/grailed.js";
import { EbayAdapter } from "./markets/ebay.js";
import { MercariAdapter } from "./markets/mercari.js";
import { RakumaAdapter } from "./markets/rakuma.js";
import { startDashboard } from "./web/server.js";
import { closeSharedBrowser } from "./core/browser.js";
import { runShutdown } from "./core/shutdown.js";
import { findDrift } from "./core/drift.js";

/**
 * Live drift smoke: boots the full stack (dashboard + poller) against a
 * throwaway database, runs ONE poll round, then re-runs the current
 * matchers over every ingested row and asserts zero drift between stored
 * and computed brand/size values. Non-zero exit on drift.
 *
 * Isolated from any real instance: DB_PATH and PORT are overridden unless
 * the caller set them explicitly.
 * Usage: npm run smoke:drift
 */
async function main(): Promise<void> {
  process.env.DB_PATH ??= "data/smoke-drift.sqlite";
  process.env.PORT ??= "3081";
  const env = loadEnv();
  ensureDbDir(env);

  const store = new Store(env.dbPath);
  const http = new HttpClient(env.rateLimitRpm);
  const adapters = [
    new YahooAuctionsAdapter(http),
    new GrailedAdapter(http),
    new EbayAdapter(http, env.ebayAppId, env.ebayCertId),
    new MercariAdapter(http, env.playwrightExecutablePath),
    new RakumaAdapter(http),
  ];
  const poller = new Poller(store, adapters, {
    pollSeconds: env.pollSeconds,
    compRoundUsd: env.compRoundUsd,
  }, async () => {});
  const dashboard = startDashboard(store, env.port, () => "");

  const shutdown = async (exitCode: number, message: string, extra?: object) => {
    await runShutdown({
      stopPolling: () => poller.stop(),
      closeNotifier: async () => {},
      closeDashboard: () => dashboard.stop(),
      closeBrowser: () => closeSharedBrowser().catch(() => {}),
      closeDispatcher: closeSharedDispatcher,
      closeStore: () => store.close(),
    }, "SIGINT");
    logger.info({ ...extra, message });
    process.exit(exitCode);
  };
  process.on("SIGINT", () => void shutdown(0, "interrupted"));
  process.on("SIGTERM", () => void shutdown(0, "terminated"));

  logger.info("drift smoke: one poll round…");
  const results = await poller.pollAllOnce();
  const totalFetched = results.reduce((a, r) => a + r.fetched, 0);
  const totalNew = results.reduce((a, r) => a + r.newListings, 0);
  logger.info({ totalFetched, totalNew }, "poll round complete");

  const rows = store.recentListings(24).map((l) => ({
    key: l.key,
    market: l.market,
    title: l.title,
    brandKey: l.brandKey,
    size: l.size,
  }));
  const drift = findDrift(rows);

  if (drift.length > 0) {
    for (const d of drift.slice(0, 20)) {
      logger.error({ key: d.key, field: d.field, stored: d.stored, computed: d.computed }, "DRIFT");
    }
    await shutdown(1, "drift smoke FAILED", { driftRows: drift.length, checked: rows.length });
  }

  await shutdown(0, "zero drift — smoke PASSED", { checked: rows.length });
}

main().catch((err) => {
  logger.error({ err }, "drift smoke crashed");
  process.exit(1);
});
