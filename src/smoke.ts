import { loadEnv, ensureDbDir } from "./config/env.js";
import { logger } from "./logger.js";
import { Store } from "./core/store.js";
import { HttpClient } from "./core/http.js";
import { Poller } from "./core/poller.js";
import { YahooAuctionsAdapter } from "./markets/yahooAuctions.js";
import { GrailedAdapter } from "./markets/grailed.js";
import { EbayAdapter } from "./markets/ebay.js";
import { MercariAdapter } from "./markets/mercari.js";
import { RakumaAdapter } from "./markets/rakuma.js";

/**
 * One-shot live check: polls each enabled market once, prints per-market
 * fetch stats and any deals. Verifies scrapers against the live web.
 * Usage: npm run smoke
 */
async function main(): Promise<void> {
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
  }, async (results) => {
    for (const r of results) {
      const line = [
        r.error ? `⚠ ${r.error}` : "✓",
        `${r.fetched} fetched`,
        `${r.newListings} new`,
        `${r.deals.length} deals`,
      ].join(" | ");
      logger.info({ market: r.market }, line);
    }
  });

  logger.info("running smoke poll (one query per market)…");
  const results = await poller.pollAllOnce();

  const totalNew = results.reduce((a, r) => a + r.newListings, 0);
  const totalDeals = results.reduce((a, r) => a + r.deals.length, 0);
  logger.info({ totalNew, totalDeals }, "smoke done");

  store.close();
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "smoke failed");
  process.exit(1);
});
