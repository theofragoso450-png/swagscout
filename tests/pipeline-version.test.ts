import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { recomputeStale } from "../src/core/recompute.js";
import { PIPELINE_VERSION } from "../src/core/pipeline.js";
import type { Listing } from "../src/types.js";

let dbPath: string;
let store: Store;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "pipeline-")), "test.db");
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

function listing(id: string, title: string, overrides: Partial<Listing> = {}): Listing {
  const l = normalizeListing({
    market: "yahoo",
    id,
    title,
    price: 1000,
    currency: "JPY",
    url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
  });
  Object.assign(l, overrides);
  return l;
}

describe("version stamping", () => {
  it("stamps fresh upserts and deals with the current version", () => {
    const l = listing("s1", "COMME des GARCONS tee", { brandKey: "cdg" });
    store.upsertListing(l);
    store.recordDeal({ listing: l, proxy: {}, reasons: [{ kind: "threshold", detail: "x" }], score: 40 });
    expect(store.get("yahoo", "s1")!.pipelineVersion).toBe(PIPELINE_VERSION);
    expect(store.recentDeals(["all"], 5)).toHaveLength(1);
  });

  it("legacy rows (pre-versioning) read as version 0 and count as stale", () => {
    // write with the current version, then downgrade the stamp to simulate
    // a row written before versioning existed
    const l = listing("s2", "COMME des GARCONS tee", { brandKey: "cdg" });
    store.upsertListing(l);
    store.transaction(() => {
      (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE listings SET pipelineVersion = 0 WHERE key = 'yahoo:s2'")
        .run();
    });
    expect(store.get("yahoo", "s2")!.pipelineVersion).toBe(0);
    expect(store.countStale()).toBe(1);
  });
});

describe("recomputeStale policy", () => {
  function seedLegacy(id: string, title: string, brandKey: string | null, size: string | null): Listing {
    const l = listing(id, title);
    store.upsertListing(l);
    store.transaction(() => {
      (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE listings SET brandKey = ?, size = ?, pipelineVersion = 0 WHERE key = ?")
        .run(brandKey, size, `yahoo:${id}`);
    });
    return l;
  }

  it("fills null brands, upgrades old labels, never un-brands", () => {
    seedLegacy("p1", "COMMEdesGARCONS jacket", null, null); // fuzzy fill
    seedLegacy("p2", "Yohji Yamamoto coat", "old-catalog-key", null); // upgrade
    seedLegacy("p3", "McGregor sweater", "yohji", null); // matcher refuses → keep

    const stats = recomputeStale(store, { compRoundUsd: 5 });

    expect(stats.brandFills).toBe(1);
    expect(stats.brandUpgrades).toBe(1);
    expect(stats.brandUnbranded).toBe(1);
    expect(store.get("yahoo", "p1")!.brandKey).toBe("cdg");
    expect(store.get("yahoo", "p2")!.brandKey).toBe("yohji");
    // never un-brand: the matcher refuses McGregor but the label survives
    expect(store.get("yahoo", "p3")!.brandKey).toBe("yohji");
    expect(store.get("yahoo", "p1")!.pipelineVersion).toBe(PIPELINE_VERSION);
  });

  it("follows the extractor on size but exempts Grailed", () => {
    seedLegacy("p4", "Yohji Yamamoto coat size L", "yohji", "M"); // extractor says L
    const g = listing("p5", "Rick Owens sneakers", { market: "grailed" });
    store.upsertListing(g);
    store.transaction(() => {
      (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db
        .prepare("UPDATE listings SET pipelineVersion = 0, size = '42' WHERE key = 'grailed:p5'")
        .run();
    });

    const stats = recomputeStale(store, { compRoundUsd: 5 });

    expect(stats.sizeFollows).toBeGreaterThanOrEqual(1);
    expect(store.get("yahoo", "p4")!.size).toBe("L");
    // Grailed size is explicit at ingest — recompute must not touch it
    expect(store.get("grailed", "p5")!.size).toBe("42");
  });

  it("rebuilds deals through the current engine (create, update, drop)", () => {
    // a rule-less brand row whose deal appears once the rule exists
    const l = seedLegacy("p6", "Y's ワイズ チュニック", "ys", null);
    l.brandKey = "ys";
    // deal computed by the OLD pipeline: no rule yet → none exists
    expect(store.dealExistsFor("yahoo:p6")).toBe(false);

    const stats = recomputeStale(store, { compRoundUsd: 5 });

    // current pipeline: ys has a $150 rule → deal created
    expect(stats.dealsCreated).toBe(1);
    expect(store.dealExistsFor("yahoo:p6")).toBe(true);
    const d = store.recentDeals(["ys"], 5)[0];
    expect(d.score).toBe(40);
    expect(d.reasons.some((r) => r.detail.includes("≤ $150"))).toBe(true);
  });

  it("is idempotent — a second pass scans nothing", () => {
    seedLegacy("p7", "COMME des GARCONS tee", null, null);
    recomputeStale(store, { compRoundUsd: 5 });
    const second = recomputeStale(store, { compRoundUsd: 5 });
    expect(second.scanned).toBe(0);
    expect(store.countStale()).toBe(0);
  });
});
