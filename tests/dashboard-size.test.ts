import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { startDashboard, type DashboardServer } from "../src/web/server.js";
import type { Listing } from "../src/types.js";

let dbPath: string;
let store: Store;
let server: DashboardServer | undefined;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-size-")), "test.db");
  store = new Store(dbPath);
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  store.close();
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

function listing(id: string, size?: string, brand = "raf"): Listing {
  const l = normalizeListing({
    market: "yahoo",
    id,
    title: `test item ${id}`,
    price: 1000,
    currency: "JPY",
    url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
  });
  l.brandKey = brand;
  if (size) l.size = size;
  return l;
}

/** Seed listings + deals (production order: upsert first, then record). */
function seed(rows: Array<[id: string, size?: string, brand?: string]>): void {
  for (const [id, size, brand] of rows) {
    const l = listing(id, size, brand);
    store.upsertListing(l);
    store.recordDeal({
      listing: l,
      proxy: {},
      reasons: [{ kind: "threshold", detail: "test" }],
      score: 50,
    });
  }
}

async function boot(): Promise<number> {
  server = startDashboard(store, 0, () => "test");
  return server.start();
}

describe("dashboard size filter", () => {
  it("/api/sizes returns distinct sizes, sorted, nulls excluded", async () => {
    seed([
      ["a1", "M"],
      ["a2", "S"],
      ["a3", "XL"],
      ["a4", undefined],
    ]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/sizes`);
    expect(await res.json()).toEqual(["M", "S", "XL"]);
  });

  it("?size=M returns only M listings (case-insensitive) and excludes unsized", async () => {
    seed([
      ["b1", "M"],
      ["b2", "m"],
      ["b3", "L"],
      ["b4", undefined],
    ]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/deals?size=M`);
    const json = (await res.json()) as { deals: Array<{ size: string | null }> };
    expect(json.deals.map((d) => d.size).sort()).toEqual(["M", "m"]);
  });

  it("an empty size param returns all deals including unsized ones", async () => {
    seed([
      ["c1", "M"],
      ["c2", undefined],
    ]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/deals?size=`);
    const json = (await res.json()) as { deals: unknown[] };
    expect(json.deals).toHaveLength(2);
  });

  it("size filter composes with the brand filter", async () => {
    seed([
      ["d1", "M", "raf"],
      ["d2", "M", "cdg"],
      ["d3", "L", "raf"],
    ]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/deals?brand=raf&size=M`);
    const json = (await res.json()) as { deals: Array<{ size: string | null }> };
    expect(json.deals).toHaveLength(1);
    expect(json.deals[0]!.size).toBe("M");
  });
});
