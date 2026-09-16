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
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-url-")), "test.db");
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

function listing(title: string, url: string, seq: number) {
  const l = normalizeListing({
    market: "yahoo",
    id: `id${seq}`,
    title,
    price: 100,
    currency: "JPY",
    url,
  });
  l.brandKey = "raf";
  // ensure deterministic newest-first ordering across tests sharing a store
  l.foundAt = new Date(Date.now() + seq).toISOString();
  return l;
}

/** Boot the real server, seed one deal, and return its payload entry. */
async function seedAndFetch(title: string, url: string): Promise<any> {
  store.recordDeal({
    listing: listing(title, url, 1),
    proxy: {},
    reasons: [{ kind: "threshold", detail: "test" }],
    score: 50,
  });
  server = startDashboard(store, 0, () => "test");
  const port = await server.start();
  const res = await fetch(`http://127.0.0.1:${port}/api/deals`);
  const json = (await res.json()) as any;
  return json.deals[0];
}

describe("dashboard URL hardening", () => {
  it("nulls a javascript: listing url (scheme allowlist)", async () => {
    const deal = await seedAndFetch("normal title", 'javascript:alert("xss")');
    expect(deal.url).toBeNull();
  });

  it("nulls a data: listing url", async () => {
    const deal = await seedAndFetch("normal title", "data:text/html,<script>alert(1)</script>");
    expect(deal.url).toBeNull();
  });

  it("nulls a vbscript: listing url", async () => {
    const deal = await seedAndFetch("normal title", 'vbscript:msgbox("x")');
    expect(deal.url).toBeNull();
  });

  it("keeps https listing urls intact", async () => {
    const deal = await seedAndFetch("normal title", "https://auctions.yahoo.co.jp/jp/auction/abc1");
    expect(deal.url).toBe("https://auctions.yahoo.co.jp/jp/auction/abc1");
  });

  it("keeps http listing urls intact", async () => {
    const deal = await seedAndFetch("normal title", "http://example.com/item/1");
    expect(deal.url).toBe("http://example.com/item/1");
  });

  it("escapes attribute breakout quotes in a hostile http url", async () => {
    // http survives the scheme gate, so a breakout attempt must arrive escaped
    const deal = await seedAndFetch(
      "normal title",
      'http://x.test/a" onmouseover="alert(1)" data-x="',
    );
    expect(deal.url).toBe("http://x.test/a%22%20onmouseover=%22alert(1)%22%20data-x=%22");
  });

  it("nulls an unparseable listing url", async () => {
    const deal = await seedAndFetch("normal title", "not a url %%%");
    expect(deal.url).toBeNull();
  });

  it("derives clean proxy links from a marketplace-controlled listing url", async () => {
    const deal = await seedAndFetch(
      "normal title",
      "https://auctions.yahoo.co.jp/jp/auction/abc123",
    );
    expect(deal.proxy.buyee).toBe("https://buyee.jp/item/yahoo/auction/abc123");
    expect(deal.proxy.zenmarket).toBe(
      "https://zenmarket.jp/en/auction.aspx?itemCode=abc123",
    );
  });
});
