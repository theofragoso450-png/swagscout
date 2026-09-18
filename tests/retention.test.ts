import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import {
  retentionDue,
  retentionTick,
  retentionKey,
  utcDay,
} from "../src/core/retention.js";
import { normalizeListing } from "../src/core/normalize.js";
import type { Deal } from "../src/types.js";

const DAY = 86_400_000;
const NOW = Date.now();

function rawDb(store: Store) {
  return store as unknown as {
    db: {
      prepare: (sql: string) => { run: (...args: unknown[]) => void; get: (...args: unknown[]) => unknown };
    };
  };
}

function listing(id: string, price: number, brandKey?: string) {
  const l = normalizeListing({
    market: "yahoo",
    id,
    title: `${brandKey ?? ""} test item ${id}`.trim(),
    price,
    currency: "JPY",
    url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
  });
  if (brandKey) l.brandKey = brandKey;
  return l;
}

/** Insert a listing whose updatedAt is `ageDays` old; returns the Listing. */
function agedListing(store: Store, id: string, ageDays: number, brandKey?: string) {
  const l = listing(id, 1000, brandKey);
  store.upsertListing(l);
  rawDb(store).db
    .prepare("UPDATE listings SET updatedAt = ? WHERE key = ?")
    .run(new Date(NOW - ageDays * DAY).toISOString(), `yahoo:${id}`);
  return l;
}

function dealFor(l: ReturnType<typeof listing>, foundAt: string): Deal {
  return {
    listing: l,
    proxy: {},
    reasons: [{ kind: "threshold", detail: "test" }],
    score: 40,
  } as unknown as Deal;
}

describe("retention: prune policy", () => {
  let store: Store;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-")), "test.db");
    store = new Store(dbPath);
  });

  it("prunes old listings, their deals, and orphans — keeps everything fresh", () => {
    const fresh = agedListing(store, "fresh", 1, "raf");
    const old = agedListing(store, "old", 40, "raf");
    store.recordDeal(dealFor(fresh, new Date(NOW - DAY).toISOString()));
    store.recordDeal(dealFor(old, new Date(NOW - 39 * DAY).toISOString()));
    // An orphan from a hypothetical earlier partial prune.
    rawDb(store).db
      .prepare("INSERT INTO deals (listingKey, market, marketId, title, priceUsd, url, reasons, score, foundAt) VALUES ('yahoo:gone', 'yahoo', 'gone', 'orphan', 10, 'https://x', '[]', 40, ?)")
      .run(new Date(NOW - DAY).toISOString());

    const res = retentionTick(store, { days: 30 }, NOW);

    expect(res).toEqual({ listingsDeleted: 1, dealsDeleted: 2 });
    expect(store.get("yahoo", "old")).toBeUndefined();
    expect(store.get("yahoo", "fresh")).toBeDefined();
    // fresh deal survived, old + orphan deals are gone:
    const remaining = rawDb(store).db.prepare("SELECT COUNT(*) AS c FROM deals").get() as unknown as { c: number };
    expect(remaining.c).toBe(1);
    expect(retentionDue(store, NOW)).toBe(false); // day marked done
    expect(store.getMeta(retentionKey(utcDay(NOW)))).toBe("done");
  });

  it("boundary: 31 days old is pruned, 29 days is not (cutoff is strict <)", () => {
    agedListing(store, "edge", 31);
    agedListing(store, "near", 29);
    retentionTick(store, { days: 30 }, NOW);
    expect(store.get("yahoo", "edge")).toBeUndefined();
    expect(store.get("yahoo", "near")).toBeDefined();
  });

  it("is idempotent within a day and resumes across days", () => {
    agedListing(store, "a1", 40);
    retentionTick(store, { days: 30 }, NOW);
    expect(retentionTick(store, { days: 30 }, NOW)).toEqual({ listingsDeleted: 0, dealsDeleted: 0 });

    const nextDay = NOW + DAY;
    agedListing(store, "a2", 40);
    const res2 = retentionTick(store, { days: 30 }, nextDay);
    expect(res2.listingsDeleted).toBe(1);
  });

  it("disabled (days: 0) never prunes and never marks the day", () => {
    agedListing(store, "x", 100);
    expect(retentionTick(store, { days: 0 }, NOW)).toEqual({ listingsDeleted: 0, dealsDeleted: 0 });
    expect(retentionDue(store, NOW)).toBe(true);
    expect(store.get("yahoo", "x")).toBeDefined();
  });

  it("checkpoint prunes freshly deleted WAL growth (smoke)", () => {
    agedListing(store, "y", 40);
    retentionTick(store, { days: 30 }, NOW);
    expect(() => store.walCheckpoint()).not.toThrow();
  });

  it("pruneBefore directly: transactional counts without scheduler", () => {
    agedListing(store, "d1", 31);
    agedListing(store, "d2", 29);
    const res = store.pruneBefore(new Date(NOW - 30 * DAY).toISOString());
    expect(res).toEqual({ listings: 1, deals: 0 });
  });
});
