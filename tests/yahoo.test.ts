import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { YahooAuctionsAdapter, parseJpRelative } from "../src/markets/yahooAuctions.js";
import { HttpClient } from "../src/core/http.js";

function fixture(name: string): string {
  return readFileSync(`tests/fixtures/${name}`, "utf8");
}

const adapter = new YahooAuctionsAdapter(new HttpClient(600));

describe("YahooAuctionsAdapter.parse", () => {
  it("parses all product cards from a fixture page", () => {
    const listings = adapter.parse(fixture("yahoo_cards.html"));
    expect(listings).toHaveLength(5);
  });

  it("extracts ids, urls and images", () => {
    const listings = adapter.parse(fixture("yahoo_cards.html"));
    const first = listings[0]!;
    expect(first.id).toBe("n123456789");
    expect(first.url).toBe("https://auctions.yahoo.co.jp/jp/auction/n123456789");
    expect(listings[1]!.imageUrl).toMatch(/^https:/); // protocol-relative src fixed
  });

  it("extracts yen prices and converts to USD", () => {
    const listings = adapter.parse(fixture("yahoo_cards.html"));
    const cdg = listings.find((l) => l.id === "n987654321")!;
    expect(cdg.price).toBe(5500);
    expect(cdg.currency).toBe("JPY");
    expect(cdg.priceUsd).toBeCloseTo(5500 / 155, 1);
  });

  it("matches JP brand aliases to brand keys", () => {
    const listings = adapter.parse(fixture("yahoo_cards.html"));
    const byId = new Map(listings.map((l) => [l.id, l]));
    expect(byId.get("n123456789")!.brandKey).toBe("yohji");
    expect(byId.get("n987654321")!.brandKey).toBe("cdg");
    expect(byId.get("n555555555")!.brandKey).toBe("raf");
    expect(byId.get("n444444444")!.brandKey).toBe("undercover");
    expect(byId.get("n111111111")!.brandKey).toBe("number-nine");
  });

  it("parses JP relative auction end times", () => {
    const listings = adapter.parse(fixture("yahoo_cards.html"));
    const yohji = listings.find((l) => l.id === "n123456789")!;
    expect(yohji.endsAt).toBeDefined();
    const endsMs = Date.parse(yohji.endsAt!);
    const minsLeft = (endsMs - Date.now()) / 60_000;
    expect(minsLeft).toBeGreaterThan(100); // ~2h
    expect(minsLeft).toBeLessThan(140);
  });

  it("parses 残り variants", () => {
    expect(parseJpRelative("残り 5分")).toBeDefined();
    expect(parseJpRelative("残り 3日")).toBeDefined();
    expect(parseJpRelative("no time")).toBeUndefined();
  });
});
