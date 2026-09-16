import { describe, expect, it } from "vitest";
import { dealMatchesSubscription } from "../src/notify/matching.js";
import type { Deal, Listing } from "../src/types.js";
import type { Subscription } from "../src/core/store.js";

function deal(size?: string, brandKey = "raf", score = 50): Deal {
  const l: Listing = {
    id: "x1",
    market: "yahoo",
    title: "test item",
    brandKey,
    size,
    price: 1000,
    currency: "JPY",
    priceUsd: 65,
    url: "https://auctions.yahoo.co.jp/jp/auction/x1",
    foundAt: new Date().toISOString(),
  };
  return { listing: l, proxy: {}, reasons: [], score };
}

function sub(overrides: Partial<Subscription>): Subscription {
  return {
    guildId: "g",
    channelId: "c",
    watch: "raf",
    minScore: 0,
    ...overrides,
  };
}

describe("dealMatchesSubscription", () => {
  it("matches when watch, score, and size all pass", () => {
    expect(dealMatchesSubscription(deal("M"), sub({ size: "M" }))).toBe(true);
  });

  it("size filter is case-insensitive", () => {
    expect(dealMatchesSubscription(deal("m"), sub({ size: "M" }))).toBe(true);
    expect(dealMatchesSubscription(deal("XL"), sub({ size: "xl" }))).toBe(true);
  });

  it("null subscription size matches any deal size", () => {
    expect(dealMatchesSubscription(deal("M"), sub({}))).toBe(true);
    expect(dealMatchesSubscription(deal(undefined), sub({}))).toBe(true);
  });

  it("a deal with no size never matches a size-filtered sub", () => {
    expect(dealMatchesSubscription(deal(undefined), sub({ size: "M" }))).toBe(false);
  });

  it("non-matching size fails even when brand and score pass", () => {
    expect(dealMatchesSubscription(deal("L"), sub({ size: "M" }))).toBe(false);
  });

  it("watch filters by brandKey; 'all' is a wildcard", () => {
    expect(dealMatchesSubscription(deal("M", "cdg"), sub({ watch: "raf" }))).toBe(false);
    expect(dealMatchesSubscription(deal("M", "cdg"), sub({ watch: "all", size: "M" }))).toBe(true);
  });

  it("minScore is a floor (>= passes, < fails)", () => {
    expect(dealMatchesSubscription(deal("M", "raf", 40), sub({ minScore: 40 }))).toBe(true);
    expect(dealMatchesSubscription(deal("M", "raf", 39.5), sub({ minScore: 40 }))).toBe(false);
  });
});
