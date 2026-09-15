import { describe, expect, it } from "vitest";
import { findComps, median, DEFAULT_COMP_OPTIONS } from "../src/core/comps.js";
import { normalizeListing } from "../src/core/normalize.js";
import type { StoredListing } from "../src/core/store.js";

function mk(title: string, priceUsd: number, market: string, id: string): StoredListing {
  return {
    key: `${market}:${id}`,
    market: market as StoredListing["market"],
    marketId: id,
    title,
    brandKey: "raf",
    item: null,
    size: null,
    price: priceUsd,
    currency: "USD",
    priceUsd: priceUsd,
    url: `https://example.com/${id}`,
    imageUrl: null,
    endsAt: null,
    foundAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const candidate = normalizeListing({
  market: "yahoo",
  id: "cand",
  title: "Raf Simons 2005AW patch jacket",
  price: 40000,
  currency: "JPY",
  url: "https://auctions.yahoo.co.jp/jp/auction/cand",
});

const grailedComp = (id: string, price: number): StoredListing =>
  mk("Raf Simons 2005AW patch jacket", price, "grailed", id);

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});

describe("findComps", () => {
  it("flags a discount when enough similar comps exist", () => {
    const comps = [grailedComp("g1", 900), grailedComp("g2", 1000), grailedComp("g3", 1100)];
    const res = findComps(candidate, comps);
    // candidate ≈ $258 vs median $1000 → ~74% discount
    expect(res).toBeDefined();
    expect(res!.discountPct).toBeGreaterThan(70);
    expect(res!.sampleSize).toBe(3);
  });

  it("returns undefined below minSample", () => {
    const comps = [grailedComp("g1", 900), grailedComp("g2", 1000)];
    expect(findComps(candidate, comps)).toBeUndefined();
  });

  it("ignores dissimilar titles", () => {
    const comps = [
      mk("Raf Simons completely different bag", 1000, "grailed", "g1"),
      mk("Raf Simons another unrelated sneaker", 1050, "ebay", "g2"),
      mk("Raf Simons third mismatched hat", 990, "grailed", "g3"),
    ];
    expect(findComps(candidate, comps)).toBeUndefined();
  });

  it("excludes the candidate itself", () => {
    const self = mk(candidate.title, 258, "yahoo", "cand");
    const comps = [self, grailedComp("g1", 1000), grailedComp("g2", 1000), grailedComp("g3", 1000)];
    const res = findComps(candidate, comps);
    expect(res).toBeDefined();
    expect(res!.samples.every((s) => s.url !== self.url || s.market !== "yahoo")).toBe(true);
  });
});
