import { describe, expect, it } from "vitest";
import { evaluateThreshold, THRESHOLD_RULES } from "../src/config/rules.js";
import { scoreDeal } from "../src/core/score.js";
import { proxyLinks } from "../src/proxy/links.js";
import { buildDealEmbed } from "../src/notify/embeds.js";
import { normalizeListing } from "../src/core/normalize.js";
import type { Deal, DealReason } from "../src/types.js";

describe("evaluateThreshold", () => {
  it("fires under the brand cap", () => {
    const d = evaluateThreshold({ brandKey: "cdg", title: "cdg t-shirt", priceUsd: 50 });
    expect(d?.maxUsd).toBe(120);
    expect(d?.note).toContain("CDG");
  });

  it("stays quiet above the cap", () => {
    expect(evaluateThreshold({ brandKey: "cdg", title: "cdg jacket", priceUsd: 300 })).toBeUndefined();
  });

  it("keeps the cap out of every note, so a cap change cannot leave a stale figure", () => {
    for (const r of THRESHOLD_RULES) {
      expect(r.note ?? "", `${r.brandKey} note`).not.toMatch(/\$/);
    }
  });

  it("respects exclude terms (reps, wallets)", () => {
    expect(
      evaluateThreshold({ brandKey: "cdg", title: "cdg t-shirt replica", priceUsd: 50 }),
    ).toBeUndefined();
    expect(
      evaluateThreshold({ brandKey: "cdg", title: "cdg play wallet", priceUsd: 50 }),
    ).toBeUndefined();
  });

  it("handles bape (nigo era) with the $180 cap", () => {
    expect(evaluateThreshold({ brandKey: "bape", title: "bapesta low", priceUsd: 150 })).toBeDefined();
    expect(evaluateThreshold({ brandKey: "bape", title: "bapesta low", priceUsd: 200 })).toBeUndefined();
    expect(
      evaluateThreshold({ brandKey: "bape", title: "bape wallet", priceUsd: 50 }),
    ).toBeUndefined();
  });

  it("excludes vape/e-cig noise from Japanese BAPE matches", () => {
    expect(
      evaluateThreshold({ brandKey: "bape", title: "電子タバコ用 ベイプ リキッド", priceUsd: 8 }),
    ).toBeUndefined();
    expect(
      evaluateThreshold({ brandKey: "bape", title: "ドクターベイプ DR.VAPE model3", priceUsd: 14 }),
    ).toBeUndefined();
  });

  it("handles evisu with the $150 cap", () => {
    expect(evaluateThreshold({ brandKey: "evisu", title: "evisu 2001 jeans", priceUsd: 120 })).toBeDefined();
    expect(evaluateThreshold({ brandKey: "evisu", title: "evisu 2001 jeans", priceUsd: 180 })).toBeUndefined();
    expect(
      evaluateThreshold({ brandKey: "evisu", title: "evisu keychain", priceUsd: 30 }),
    ).toBeUndefined();
  });

  it("gates supreme on early-2000s era terms", () => {
    expect(
      evaluateThreshold({ brandKey: "supreme", title: "supreme 2003 box logo tee", priceUsd: 220 }),
    ).toBeDefined();
    expect(
      evaluateThreshold({ brandKey: "supreme", title: "supreme fw02 parka", priceUsd: 240 }),
    ).toBeDefined();
    expect(
      evaluateThreshold({ brandKey: "supreme", title: "シュプリーム 00年代 ヴィンテージ", priceUsd: 150 }),
    ).toBeDefined();
    // modern, untagged supreme stays quiet (comp engine territory)
    expect(
      evaluateThreshold({ brandKey: "supreme", title: "supreme ss24 tee", priceUsd: 60 }),
    ).toBeUndefined();
    // above cap even when era-tagged
    expect(
      evaluateThreshold({ brandKey: "supreme", title: "supreme 2001 bogo", priceUsd: 400 }),
    ).toBeUndefined();
    // accessories excluded
    expect(
      evaluateThreshold({ brandKey: "supreme", title: "supreme 2002 sticker", priceUsd: 10 }),
    ).toBeUndefined();
  });

  it("ignores brands without rules", () => {
    expect(evaluateThreshold({ brandKey: "guidi", title: "guidi boots", priceUsd: 100 })).toBeDefined();
    expect(evaluateThreshold({ brandKey: "nope", title: "nope thing", priceUsd: 10 })).toBeUndefined();
  });
});

describe("evaluateThreshold — ys", () => {
  it("fires under the $150 cap", () => {
    const d = evaluateThreshold({ brandKey: "ys", title: "Y's ワイズ チュニック", priceUsd: 19 });
    expect(d?.maxUsd).toBe(150);
    expect(d?.note).toContain("Y's (Yohji women's)");
  });

  it("stays quiet above the cap", () => {
    expect(evaluateThreshold({ brandKey: "ys", title: "Y's ワイズ コート", priceUsd: 180 })).toBeUndefined();
  });

  it("respects exclude terms (reps)", () => {
    expect(evaluateThreshold({ brandKey: "ys", title: "Y's replica one-piece", priceUsd: 50 })).toBeUndefined();
  });
});

describe("scoreDeal", () => {
  const listing = normalizeListing({
    market: "yahoo",
    id: "s1",
    title: "test",
    price: 1000,
    currency: "JPY",
    url: "https://x.test/1",
  });

  it("scores threshold + comp higher than threshold alone", () => {
    const onlyThreshold = scoreDeal(listing, [{ kind: "threshold", detail: "x" }]);
    const both = scoreDeal(listing, [
      { kind: "threshold", detail: "x" },
      { kind: "comp", detail: "y" },
    ], { discountPct: 60 });
    expect(both).toBeGreaterThan(onlyThreshold);
  });

  it("adds urgency bonus for auctions ending soon", () => {
    const soon = normalizeListing({
      market: "yahoo",
      id: "s2",
      title: "test",
      price: 1000,
      currency: "JPY",
      url: "https://x.test/2",
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const withUrgency = scoreDeal(soon, [{ kind: "threshold", detail: "x" }]);
    const without = scoreDeal(listing, [{ kind: "threshold", detail: "x" }]);
    expect(withUrgency).toBe(without + 10);
  });
});

describe("proxyLinks", () => {
  it("builds proxy URLs for Yahoo auctions", () => {
    const l = normalizeListing({
      market: "yahoo",
      id: "n123456789",
      title: "test",
      price: 1000,
      currency: "JPY",
      url: "https://auctions.yahoo.co.jp/jp/auction/n123456789",
    });
    const p = proxyLinks(l);
    expect(p.buyee).toBe("https://buyee.jp/item/yahoo/auction/n123456789");
    expect(p.zenmarket).toContain("zenmarket.jp");
    expect(p.sendico).toContain("sendico");
  });

  it("returns empty for western markets", () => {
    const l = normalizeListing({
      market: "grailed",
      id: "1",
      title: "test",
      price: 100,
      currency: "USD",
      url: "https://www.grailed.com/listings/1",
    });
    expect(proxyLinks(l)).toEqual({});
  });
});

describe("buildDealEmbed", () => {
  it("builds a rich embed with proxy links and reasons", () => {
    const listing = normalizeListing({
      market: "yahoo",
      id: "n1",
      title: "ヨウジヤマモト シャツ",
      price: 12000,
      currency: "JPY",
      url: "https://auctions.yahoo.co.jp/jp/auction/n1",
    });
    listing.brandKey = "yohji";
    const deal: Deal = {
      listing,
      proxy: proxyLinks(listing),
      reasons: [{ kind: "threshold", detail: "price $77 ≤ $350 — Yohji mainline under $350" }],
      score: 42,
    };
    const embed = buildDealEmbed(deal);
    expect(embed.title).toContain("ヨウジヤマモト");
    expect(embed.url).toContain("auctions.yahoo.co.jp");
    const why = embed.fields.find((f) => f.name === "Why it's a deal")!;
    expect(why.value).toContain("≤ $350");
    const proxyField = embed.fields.find((f) => f.name === "Proxy buy")!;
    expect(proxyField.value).toContain("Buyee");
    expect(embed.footer?.text).toContain("score 42");
  });
});
