import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";

let dbPath: string;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-")), "test.db");
});

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

describe("Store", () => {
  it("sellThroughByBrand: gone-now share per brand, honest on stale and missing data", () => {
    const store = new Store(dbPath);
    const seed = (id: string, brand: string, missing: boolean) => {
      store.upsertListing(listing(id, 1000, brand));
      if (missing) store.applyAbsences("yahoo", new Date().toISOString(), [`yahoo:${id}`]);
    };
    // yohji: 3 gone of 4 → 0.75; cdg: 0 of 2 → 0; raf: unbranded rows only.
    seed("y1", "yohji", true);
    seed("y2", "yohji", true);
    seed("y3", "yohji", true);
    seed("y4", "yohji", false);
    seed("c1", "cdg", false);
    seed("c2", "cdg", false);
    seed("u1");
    seed("u2");
    const v = store.sellThroughByBrand(24);
    expect(v.get("yohji")).toEqual({ gone: 3, total: 4, share: 0.75 });
    expect(v.get("cdg")).toEqual({ gone: 0, total: 2, share: 0 });
    expect(v.has("raf")).toBe(false); // unbranded rows never pollute the map

    // A brand with no fresh ingest inside the cutoff is dropped entirely:
    // a paused or blocked market must not read as stellar sell-through.
    const old = store.sellThroughByBrand(0);
    expect(old.has("yohji")).toBe(false);
    expect(old.has("cdg")).toBe(false);
  });

  it("roundtrips listings and detects unseen ids", () => {
    const store = new Store(dbPath);
    const l = listing("n1", 1000, "raf");
    expect(store.has("yahoo", "n1")).toBe(false);
    store.upsertListing(l);
    expect(store.has("yahoo", "n1")).toBe(true);

    const got = store.get("yahoo", "n1")!;
    expect(got.title).toBe(l.title);
    expect(got.priceUsd).toBeCloseTo(l.priceUsd, 1);
    store.close();
  });

  it("updates price on re-upsert (dedupe by market+id)", () => {
    const store = new Store(dbPath);
    store.upsertListing(listing("n2", 1000, "raf"));
    store.upsertListing(listing("n2", 800, "raf"));
    const got = store.get("yahoo", "n2")!;
    expect(got.price).toBe(800);
    store.close();
  });

  it("stores and lists subscriptions", () => {
    const store = new Store(dbPath);
    store.addSubscription({ guildId: "g1", channelId: "c1", watch: "raf", minScore: 40 });
    store.addSubscription({ guildId: "g1", channelId: "c1", watch: "all", minScore: 0 });

    expect(store.subscriptionsFor("raf")).toHaveLength(2); // brand + all
    expect(store.subscriptionsFor("cdg")).toHaveLength(1); // just "all"

    expect(store.removeSubscription("g1", "c1", "raf")).toBe(true);
    expect(store.subscriptionsFor("raf")).toHaveLength(1);
    store.close();
  });

  it("records and retrieves deal history", () => {
    const store = new Store(dbPath);
    const l = listing("n3", 5000, "cdg");
    l.brandKey = "cdg";
    store.recordDeal({
      listing: l,
      proxy: { buyee: "https://buyee.jp/x" },
      reasons: [{ kind: "threshold", detail: "test reason" }],
      score: 55,
    });
    const deals = store.recentDeals(["all"], 10);
    expect(deals).toHaveLength(1);
    expect(deals[0]!.listing.title).toBe(l.title);
    expect(deals[0]!.reasons[0]!.kind).toBe("threshold");

    const byBrand = store.recentDeals(["cdg"], 10);
    expect(byBrand).toHaveLength(1);
    const other = store.recentDeals(["raf"], 10);
    expect(other).toHaveLength(0);
    store.close();
  });

  it("returns brand-filtered deals even when buried under newer rows", () => {
    const store = new Store(dbPath);
    // one old cdg deal, then 250 newer raf deals pushing it past the
    // unfiltered newest-N window
    const old = listing("n4", 3000, "cdg");
    old.foundAt = new Date(Date.now() - 3_600_000).toISOString();
    store.recordDeal({
      listing: old,
      proxy: { buyee: "https://buyee.jp/x" },
      reasons: [{ kind: "threshold", detail: "test reason" }],
      score: 40,
    });
    for (let i = 0; i < 250; i++) {
      const l = listing(`bulk${i}`, 1000 + i, "raf");
      store.recordDeal({
        listing: l,
        proxy: {},
        reasons: [{ kind: "threshold", detail: "test reason" }],
        score: 40,
      });
    }
    const byBrand = store.recentDeals(["cdg"], 10, { brand: "cdg" });
    expect(byBrand).toHaveLength(1);
    expect(byBrand[0]!.listing.brandKey).toBe("cdg");
    store.close();
  });

  it("persists and clears a subscription size filter (roundtrip)", () => {
    const store = new Store(dbPath);
    store.addSubscription({ guildId: "g1", channelId: "c1", watch: "raf", minScore: 10, size: "M" });
    store.addSubscription({ guildId: "g1", channelId: "c1", watch: "cdg", minScore: 0 });
    let subs = store.listSubscriptions();
    expect(subs.find((s) => s.watch === "raf")!.size).toBe("M");
    expect(subs.find((s) => s.watch === "cdg")!.size ?? null).toBeNull();
    // re-watch without size clears the filter (same row, upsert)
    store.addSubscription({ guildId: "g1", channelId: "c1", watch: "raf", minScore: 10 });
    subs = store.listSubscriptions();
    expect(subs.find((s) => s.watch === "raf")!.size ?? null).toBeNull();
    store.close();
  });

  it("stores meta values", () => {
    const store = new Store(dbPath);
    store.setMeta("lastRun", "123");
    expect(store.getMeta("lastRun")).toBe("123");
    store.close();
  });
});
