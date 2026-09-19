import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { startDashboard, type DashboardServer } from "../src/web/server.js";

let dbPath: string;
let store: Store;
let server: DashboardServer | undefined;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-a11y-")), "test.db");
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

function listing(title: string, seq: number) {
  const l = normalizeListing({
    market: "yahoo",
    id: `id${seq}`,
    title,
    price: 100,
    currency: "JPY",
    url: `https://auctions.yahoo.co.jp/jp/auction/${seq}`,
  });
  l.brandKey = "raf";
  // deterministic newest-first ordering
  l.foundAt = new Date(Date.now() + seq).toISOString();
  return l;
}

async function boot(): Promise<number> {
  server = startDashboard(store, 0, () => "test");
  return server.start();
}

async function page(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

describe("dashboard accessibility contract", () => {
  it("declares the document language and labels every filter control", async () => {
    const html = await page(await boot());
    expect(html).toContain('<html lang="en">');
    for (const label of ["Market", "Brand", "Size", "Sort by", "Filter titles"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("exposes connection state as a polite live region instead of color alone", async () => {
    const html = await page(await boot());
    // the dot is decorative; markLive() announces state through #live
    expect(html).toContain('<span id="dot" aria-hidden="true"></span>');
    expect(html).toMatch(/id="live"[^>]*role="status"[^>]*aria-live="polite"/);
    // without the sr-only rule the region would render visibly in the header
    expect(html).toContain(".sr-only {");
  });
});

describe("wire titleLang", () => {
  it("tags Japanese titles ja and leaves non-Japanese unset", async () => {
    const cases: Array<[string, number]> = [
      ["コムデギャルソン シャツ", 1],
      ["ヴィンテージ バッグ", 2],
      ["Undercover wool sweater", 3],
    ];
    for (const [title, seq] of cases) {
      store.recordDeal({
        listing: listing(title, seq),
        proxy: {},
        reasons: [{ kind: "threshold", detail: "test" }],
        score: 50,
      });
    }
    const json = (await (await fetch(`http://127.0.0.1:${(await boot())}/api/deals`)).json()) as {
      deals: Array<{ title: string; titleLang: string | null }>;
    };
    const langs = new Map(json.deals.map((d) => [d.title, d.titleLang]));
    expect(langs.get("コムデギャルソン シャツ")).toBe("ja");
    expect(langs.get("ヴィンテージ バッグ")).toBe("ja");
    expect(langs.get("Undercover wool sweater")).toBeNull();
  });
});
