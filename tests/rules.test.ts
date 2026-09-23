import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { evaluateThreshold, THRESHOLD_RULES, RULES_BY_BRAND } from "../src/config/rules.js";
import { scoreDeal, evaluateDeal } from "../src/core/score.js";
import { extractCondition } from "../src/core/normalize.js";
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

describe("evaluateThreshold — condition-aware caps (v0.5.0 unit 5)", () => {
  // The live yohji rule: maxUsd 350, no conditionCaps (default policy).
  it("fires clean-condition listings exactly as before", () => {
    expect(
      evaluateThreshold({ brandKey: "yohji", title: "ヨウジヤマモト シャツ", priceUsd: 300, condition: "like-new" }),
    ).toBeDefined();
    // No label at all — never hit a cap it never asked for.
    expect(evaluateThreshold({ brandKey: "yohji", title: "ヨウジヤマモト シャツ", priceUsd: 300 })).toBeDefined();
  });

  it("does not fire a junk-grade listing above the default degraded cap", () => {
    // $300 > 350/2 — a junk grade is not a deal at a clean listing's price.
    expect(
      evaluateThreshold({ brandKey: "yohji", title: "ヨウジヤマモト シャツ", priceUsd: 300, condition: "junk" }),
    ).toBeUndefined();
    // But below half-cap it fires.
    const d = evaluateThreshold({ brandKey: "yohji", title: "ヨウジヤマモト シャツ", priceUsd: 150, condition: "junk" });
    expect(d?.maxUsd).toBe(175);
  });

  it("used keeps the full cap — only junk carries the deeper-discount factor", () => {
    expect(evaluateThreshold({ brandKey: "yohji", title: "yohji shirt", priceUsd: 300, condition: "used" })?.maxUsd).toBe(350);
  });

  it("every shipped rule opts into the junk factor", () => {
    for (const r of THRESHOLD_RULES) {
      expect(r.junkFactor ?? 1, `${r.brandKey}`).toBe(0.5);
      expect(r.junkFactor!, `${r.brandKey} factor in (0,1]`).toBeGreaterThan(0);
      expect(r.junkFactor!, `${r.brandKey} factor in (0,1]`).toBeLessThanOrEqual(1);
    }
  });

  it("a rule with conditionCaps sets its own bar (matrix per the roadmap)", () => {
    const rule = RULES_BY_BRAND.get("yohji")!;
    const saved = rule.conditionCaps;
    try {
      rule.conditionCaps = { junk: false, used: 100 };
      // junk: disabled entirely — no price clears it.
      expect(evaluateThreshold({ brandKey: "yohji", title: "yohji shirt", priceUsd: 10, condition: "junk" })).toBeUndefined();
      // used: fires only below its explicit cap.
      expect(evaluateThreshold({ brandKey: "yohji", title: "yohji shirt", priceUsd: 150, condition: "used" })).toBeUndefined();
      expect(evaluateThreshold({ brandKey: "yohji", title: "yohji shirt", priceUsd: 90, condition: "used" })?.maxUsd).toBe(100);
      // clean conditions keep the full cap.
      expect(evaluateThreshold({ brandKey: "yohji", title: "yohji shirt", priceUsd: 300, condition: "new" })).toBeDefined();
    } finally {
      rule.conditionCaps = saved;
    }
  });

  it("capless-and-factorless rules behave exactly as today (the opt-in contract)", () => {
    const rule = RULES_BY_BRAND.get("cdg")!;
    expect(rule.conditionCaps).toBeUndefined();
    const saved = rule.junkFactor;
    try {
      delete rule.junkFactor; // a rule that never opted in
      // Junk on the FULL cap, identical to pre-unit-5 behavior.
      expect(evaluateThreshold({ brandKey: "cdg", title: "cdg tee", priceUsd: 100, condition: "junk" })?.maxUsd).toBe(120);
      expect(evaluateThreshold({ brandKey: "cdg", title: "cdg tee", priceUsd: 100, condition: "used" })).toBeDefined();
    } finally {
      rule.junkFactor = saved;
    }
  });

  it("condition parses from the title through the real path (evaluateDeal)", () => {
    const store = new Store(mkdtempSync(path.join(tmpdir(), "swagscout-cond-")) + "\\test.db");
    try {
      const junk = normalizeListing({
        market: "yahoo",
        id: "j1",
        title: "ヨウジヤマモト シャツ ジャンク",
        price: 48000,
        currency: "JPY",
        url: "https://auctions.yahoo.co.jp/jp/auction/j1",
      });
      junk.brandKey = "yohji";
      expect(extractCondition(junk.title)).toBe("junk");
      // ~$310: under the full cap, over the junk factor cap (175) → no deal.
      expect(evaluateDeal(junk, { store, compRoundUsd: 50 })).toBeUndefined();
      // Same price, clean title → threshold deal as always.
      const clean = { ...junk, id: "j2", title: "ヨウジヤマモト シャツ" };
      const deal = evaluateDeal(clean, { store, compRoundUsd: 50 });
      expect(deal?.reasons.some((r) => r.kind === "threshold")).toBe(true);
    } finally {
      store.close();
      rmSync(path.join(tmpdir(), "swagscout-cond-"), { recursive: true, force: true });
    }
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
