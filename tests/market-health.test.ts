import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Poller } from "../src/core/poller.js";
import { Store } from "../src/core/store.js";
import type { MarketAdapter } from "../src/markets/types.js";
import type { Listing, MarketId } from "../src/types.js";

/**
 * Market health: the poller records every completed query cycle (and every
 * failed attempt) per market, and the store turns that into the per-market
 * liveness the dashboard status line and /status render. The claim under test
 * is the lifecycle — success stamps ✓, a thrown fetch stamps ! — and that a
 * market with no record reads as unknown, never as healthy.
 */

const POLL_SECONDS: Record<MarketId, number> = {
  yahoo: 30,
  grailed: 45,
  ebay: 60,
  mercari: 90,
  rakuma: 90,
};

function listing(id: string): Listing {
  return {
    id,
    market: "mercari",
    title: `cdg tee ${id}`,
    brandKey: "cdg",
    price: 9300,
    currency: "JPY",
    priceUsd: 60,
    url: `https://jp.mercari.com/item/${id}`,
    foundAt: new Date().toISOString(),
  };
}

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swagscout-health-"));
  dbPath = path.join(dir, "test.db");
  store = new Store(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** A completed cycle needs every query term of the watchlist to get a turn. */
async function pollUntilRoundRecorded(poller: Poller, maxTicks = 10): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    await poller.pollMarket("mercari");
    if (store.marketHealth().find((m) => m.market === "mercari")?.lastRoundOk === true) return;
  }
  throw new Error("no successful round recorded within tick budget");
}

describe("market health", () => {
  it("reads all five markets as unknown on a fresh store", () => {
    const health = store.marketHealth();
    expect(health.map((h) => h.market)).toEqual(["yahoo", "grailed", "ebay", "mercari", "rakuma"]);
    for (const h of health) {
      expect(h.lastRoundAt).toBeNull();
      expect(h.lastRoundOk).toBeNull();
      expect(h.lastRoundItems).toBeNull();
      expect(h.rows24h).toBe(0);
      expect(h.latestListingAt).toBeNull();
    }
  });

  it("a completed poll cycle stamps a successful round with its item count", async () => {
    const adapter: MarketAdapter = {
      id: "mercari",
      searchUrl: (q) => q,
      search: async () => [listing("a"), listing("b")],
    };
    const poller = new Poller(store, [adapter], { pollSeconds: POLL_SECONDS, compRoundUsd: 50, watchKeys: ["cdg"] }, async () => {});
    await pollUntilRoundRecorded(poller);

    const h = store.marketHealth().find((m) => m.market === "mercari")!;
    expect(h.lastRoundOk).toBe(true);
    expect(h.lastRoundAt).not.toBeNull();
    expect(Date.now() - (h.lastRoundAt ?? 0)).toBeLessThan(60_000);
    // The wrap saw both listings of the cycle in the seen-set.
    expect(h.lastRoundItems).toBe(2);
    expect(h.rows24h).toBe(2);
    expect(h.latestListingAt).not.toBeNull();
    // Other markets remain unknown — one market answering says nothing about the rest.
    expect(store.marketHealth().find((m) => m.market === "yahoo")!.lastRoundOk).toBeNull();
  });

  it("a thrown fetch stamps a failed attempt so the market shows '!' until it answers", async () => {
    const adapter: MarketAdapter = {
      id: "mercari",
      searchUrl: (q) => q,
      search: async () => {
        throw new Error("cloudflare attention required");
      },
    };
    const poller = new Poller(store, [adapter], { pollSeconds: POLL_SECONDS, compRoundUsd: 50, watchKeys: ["cdg"] }, async () => {});
    await poller.pollMarket("mercari");

    const h = store.marketHealth().find((m) => m.market === "mercari")!;
    expect(h.lastRoundOk).toBe(false);
    expect(h.lastRoundAt).not.toBeNull();
    expect(h.lastRoundItems).toBe(0);
  });

  it("rows24h counts only the last day of rows, across markets", () => {
    store.recordMarketRound("yahoo", { at: new Date().toISOString(), ok: true, queries: 1, items: 1 });
    const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const upsert = (m: MarketId, id: string, foundAt: string) =>
      store.upsertListing({ ...listing(id), market: m, foundAt });
    upsert("mercari", "fresh", new Date().toISOString());
    upsert("mercari", "stale", old(3));
    upsert("yahoo", "yf", new Date().toISOString());
    // A fresh upsert always stamps updatedAt "now", so age one row past the
    // window via direct SQL — that column is what the 24h window reads.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE listings SET updatedAt = ? WHERE key = ?").run(old(3), "mercari:stale");
    db.close();

    const health = Object.fromEntries(store.marketHealth().map((h) => [h.market, h]));
    expect(health.mercari.rows24h).toBe(1);
    expect(health.mercari.latestListingAt).not.toBeNull();
    expect(health.yahoo.rows24h).toBe(1);
    expect(health.yahoo.lastRoundOk).toBe(true);
    expect(health.grailed.rows24h).toBe(0);
  });

  it("the served /api/health carries the same liveness the store reports", async () => {
    store.recordMarketRound("rakuma", { at: new Date().toISOString(), ok: false, queries: 0, items: 0 });
    const { startDashboard } = await import("../src/web/server.js");
    const dash = startDashboard(store, 0, () => "stats");
    const port = await dash.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { marketHealth: Array<{ market: string; lastRoundOk: boolean | null }> };
      expect(body.marketHealth).toHaveLength(5);
      expect(body.marketHealth.find((m) => m.market === "rakuma")!.lastRoundOk).toBe(false);

      // The deals feed carries the same health so the dashboard can render
      // status chips without a second request.
      const deals = await (await fetch(`http://127.0.0.1:${port}/api/deals`)).json();
      expect(Array.isArray(deals.marketHealth)).toBe(true);
      expect(deals.marketHealth.find((m) => m.market === "rakuma")).toEqual(
        body.marketHealth.find((m) => m.market === "rakuma"),
      );
    } finally {
      await dash.stop();
    }
  });
});
