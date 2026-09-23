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
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-finds-")), "test.db");
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

function listing(id: string): Listing {
  const l = normalizeListing({
    market: "yahoo",
    id,
    title: `test item ${id}`,
    price: 1000,
    currency: "JPY",
    url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
  });
  l.brandKey = "raf";
  return l;
}

function seed(id: string, reasons: Array<{ kind: string; detail: string }>): void {
  const l = listing(id);
  store.upsertListing(l);
  store.recordDeal({ listing: l, proxy: {}, reasons: reasons as never, score: 50 });
}

async function boot(): Promise<number> {
  server = startDashboard(store, 0, () => "test");
  return server.start();
}

describe("/api/finds", () => {
  it("ranks comp-backed deals and excludes threshold-only ones", async () => {
    seed("f1", [{ kind: "comp", detail: "50% below 20-listing median ($400)" }]);
    seed("f2", [{ kind: "comp", detail: "20% below 5-listing median ($80)" }]);
    seed("f3", [{ kind: "threshold", detail: "test" }]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/finds`);
    const json = (await res.json()) as {
      finds: Array<{ rank: number; tier: string; findLabel: string; title: string; url: string | null }>;
    };
    expect(json.finds.map((f) => f.title)).toEqual(["test item f1", "test item f2"]);
    expect(json.finds.map((f) => f.rank)).toEqual([1, 2]);
    expect(json.finds[0]!.tier).toBe("A");
    expect(json.finds[0]!.findLabel).toContain("#1");
    // dealItem contract the shared renderer relies on
    expect(json.finds[0]!.url).toContain("auctions.yahoo.co.jp");
  });

  it("returns an empty list when nothing comp-backed exists", async () => {
    seed("f4", [{ kind: "threshold", detail: "test" }]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/finds`);
    const json = (await res.json()) as { finds: unknown[] };
    expect(json.finds).toEqual([]);
  });

  it("flags fast movers when the brand's gone-now share clears the bar", async () => {
    // raf brand: two gone-now of four stored rows → share 0.5 = FAST_MOVER_SHARE.
    // Fillers must not join v3/v4's comp pool: disjoint titles fail the token
    // overlap, so the finds' comp discounts stay untouched.
    const filler = (id: string) => {
      const l = listing(id);
      l.title = `totally unrelated object ${id}`;
      store.upsertListing(l);
    };
    filler("v1");
    filler("v2");
    store.applyAbsences("yahoo", new Date().toISOString(), ["yahoo:v1", "yahoo:v2"]);
    seed("v3", [{ kind: "comp", detail: "50% below 20-listing median ($400)" }]);
    seed("v4", [{ kind: "comp", detail: "50% below 20-listing median ($400)" }]);
    const port = await boot();
    const res = await fetch(`http://127.0.0.1:${port}/api/finds`);
    const json = (await res.json()) as { finds: Array<{ title: string; fast: boolean }> };
    const byTitle = new Map(json.finds.map((f) => [f.title, f.fast]));
    expect(byTitle.get("test item v3")).toBe(true);
    expect(byTitle.get("test item v4")).toBe(true);
  });
});
