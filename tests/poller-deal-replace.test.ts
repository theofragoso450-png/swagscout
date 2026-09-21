import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Poller } from "../src/core/poller.js";
import { Store } from "../src/core/store.js";
import { DiscordNotifier } from "../src/notify/discord.js";
import { findsPool } from "../src/notify/finds.js";
import type { MarketAdapter } from "../src/markets/types.js";
import type { Deal, Listing, MarketId } from "../src/types.js";

/**
 * One deal row per listing. A price drop is a new verdict on an item the store
 * already has, so it must REPLACE that item's deal: appending left two rows,
 * which renders as the same card twice, puts the same item in the daily digest
 * pool twice, and (before the recompute pass collapsed them) doubled the rows a
 * 10k-listing store held.
 *
 * The scenario runs through the real Poller against a temp database, and the
 * row count is read on a second connection — the claim is about what is
 * actually persisted, not about what the poller returned.
 */

const POLL_SECONDS: Record<MarketId, number> = {
  yahoo: 30,
  grailed: 45,
  ebay: 60,
  mercari: 90,
  rakuma: 90,
};
const KEY = "mercari:x1";
const URL = "https://jp.mercari.com/item/x1";

/** JPY at the static fallback rate (1/155), priced under the $120 cdg cap.
 *  The title avoids every excluded term — "rep" matches inside "replace". */
function listing(price: number): Listing {
  return {
    id: "x1",
    market: "mercari",
    title: "cdg tee drop-test",
    brandKey: "cdg",
    price,
    currency: "JPY",
    priceUsd: Math.round((price / 155) * 100) / 100,
    url: URL,
    foundAt: new Date().toISOString(),
  };
}

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swagscout-replace-"));
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

/** Rows persisted for the listing — the claim this file exists to pin. */
function dealRows(): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS c FROM deals WHERE listingKey = ?").get(KEY) as {
      c: number;
    };
    return Number(row.c);
  } finally {
    db.close();
  }
}

/** New listing → drop → unchanged → drop again, one poll per step. */
function newPoller() {
  const pages = [listing(12000), listing(8000), listing(8000), listing(6000)];
  let step = 0;
  const adapter: MarketAdapter = {
    id: "mercari",
    searchUrl: (q) => q,
    search: async () => [pages[Math.min(step++, pages.length - 1)]],
  };
  const poller = new Poller(
    store,
    [adapter],
    { pollSeconds: POLL_SECONDS, compRoundUsd: 50, watchKeys: ["cdg"] },
    async () => {},
  );
  return { poller, run: () => poller.pollMarket("mercari") };
}

describe("a price drop replaces the listing's deal", () => {
  it("keeps exactly one row across drops, and writes nothing when the price holds", async () => {
    const { poller, run } = newPoller();

    // ¥12,000 ≈ $77 — new listing, the first (and only) deal row for it.
    const first = await run();
    expect(first.deals).toHaveLength(1);
    expect(dealRows()).toBe(1);

    // ¥8,000 ≈ $52, a 33% drop. The regression: the old drop branch appended a
    // second row here, so the count became 2.
    const drop = await run();
    expect(drop.priceDrops).toBe(1);
    expect(drop.deals).toHaveLength(1);
    expect(drop.deals[0]?.reasons.some((r) => r.kind === "price_drop")).toBe(true);
    expect(dealRows()).toBe(1);

    // Same price: nothing to say, and no row churn.
    const steady = await run();
    expect(steady.deals).toHaveLength(0);
    expect(dealRows()).toBe(1);

    // A second drop swaps the row again rather than stacking a third.
    const second = await run();
    expect(second.deals).toHaveLength(1);
    expect(dealRows()).toBe(1);

    // The surviving row is the latest verdict and kept the drop reason.
    expect(store.dealReasonsFor(KEY).some((r) => r.kind === "price_drop")).toBe(true);
    expect(store.recentDeals(["all"], 50).filter((d) => d.listing.id === "x1")).toHaveLength(1);
    poller.stop();
  });

  it("alerts once per event, and lists the item once in the digest pool", async () => {
    const { poller, run } = newPoller();
    const notifier = new DiscordNotifier(store, {
      webhookUrl: "https://example.test/hook",
      allowedChannels: [],
    });

    const bodies: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      bodies.push(String(init?.body ?? ""));
      return { ok: true, status: 204, text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;

    try {
      for (let i = 0; i < 4; i++) {
        await notifier.sendDeals([await run()]);
      }
    } finally {
      globalThis.fetch = original;
    }

    // Three events (new, drop, drop) — one post each, naming the item once.
    // The fourth poll found no change and must post nothing.
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body.split(URL)).toHaveLength(2); // exactly one mention
    }

    // The daily digest posts from this pool, so a duplicate row would put the
    // same find into one morning post twice.
    const pool = findsPool(Date.now());
    const digestPool = store
      .recentDeals(["all"], pool.limit, { since: pool.since })
      .filter((d: Deal) => d.listing.id === "x1");
    expect(digestPool).toHaveLength(1);
    poller.stop();
  });
});
