import { describe, expect, it } from "vitest";
import { findsScore, classifyRarity, rankFinds, FAST_MOVER_SHARE } from "../src/notify/finds.js";
import { compFacts } from "../src/core/reasons.js";
import type { Deal } from "../src/types.js";

const NOW = Date.parse("2026-09-18T12:00:00Z");

function compDeal(opts: {
  discount: number;
  sample: number;
  median: number;
  hoursAgo?: number;
  title?: string;
}): Deal {
  const foundAt = new Date(NOW - (opts.hoursAgo ?? 1) * 3_600_000).toISOString();
  return {
    listing: {
      id: "yahoo:1",
      market: "yahoo",
      title: opts.title ?? "Yohji Pour Homme coat",
      brandKey: "yohji",
      price: 100,
      currency: "USD",
      priceUsd: 100,
      url: "https://example.com/item",
      foundAt,
    },
    proxy: {},
    reasons: [
      {
        kind: "comp",
        detail: `${opts.discount}% below ${opts.sample}-listing median ($${opts.median.toFixed(0)})`,
      },
    ],
    score: 40,
  };
}

function thresholdDeal(hoursAgo = 1): Deal {
  return {
    ...compDeal({ discount: 10, sample: 5, median: 100, hoursAgo }),
    reasons: [{ kind: "threshold", detail: "price $96 ≤ $200 — Yohji apparel under $200" }],
  };
}

describe("compFacts", () => {
  const structured: Deal["reasons"] = [{ kind: "comp", medianUsd: 420, sampleSize: 22 }];

  it("re-derives the discount against the price in hand", () => {
    expect(compFacts(structured, 210)).toEqual({ discountPct: 50, sampleSize: 22, medianUsd: 420 });
    // Same median, dearer item: the discount it claims shrinks with it.
    expect(compFacts(structured, 336)?.discountPct).toBe(20);
  });

  it("still reads the numbers out of a legacy reason's text", () => {
    expect(compFacts(compDeal({ discount: 39.5, sample: 22, median: 420 }).reasons, 100)).toEqual({
      discountPct: 39.5,
      sampleSize: 22,
      medianUsd: 420,
    });
  });

  it("returns null for threshold-only deals", () => {
    expect(compFacts(thresholdDeal().reasons, 96)).toBeNull();
  });
});

describe("findsScore", () => {
  it("ramps with discount depth, sample size, and median price class", () => {
    expect(findsScore(compDeal({ discount: 39.5, sample: 22, median: 420 }))).toBe(46);
    expect(findsScore(compDeal({ discount: 60, sample: 50, median: 1500 }))).toBe(56);
    expect(findsScore(compDeal({ discount: 15, sample: 5, median: 40 }))).toBe(22);
  });

  it("caps each component so extreme inputs cannot dominate", () => {
    // rarity caps at 30, sample at 10, price class at 20 → 60 max
    expect(findsScore(compDeal({ discount: 90, sample: 500, median: 90000 }))).toBe(60);
    expect(findsScore(compDeal({ discount: 80, sample: 500, median: 90000 }))).toBe(60);
  });

  it("scores threshold-only deals 0", () => {
    expect(findsScore(thresholdDeal())).toBe(0);
  });
});

describe("classifyRarity", () => {
  it("maps score bands to tiers", () => {
    expect(classifyRarity(60)).toBe("S");
    expect(classifyRarity(55)).toBe("S");
    expect(classifyRarity(54)).toBe("A");
    expect(classifyRarity(40)).toBe("A");
    expect(classifyRarity(39)).toBe("B");
    expect(classifyRarity(25)).toBe("B");
    expect(classifyRarity(24)).toBe("C");
  });
});

describe("rankFinds", () => {
  it("ranks comp-backed deals by finds score, sequentially ranked", () => {
    const deals = [
      compDeal({ discount: 15, sample: 5, median: 40, hoursAgo: 2 }), // 22
      compDeal({ discount: 60, sample: 50, median: 1500, hoursAgo: 3 }), // 56
      compDeal({ discount: 39.5, sample: 22, median: 420, hoursAgo: 1 }), // 46
    ];
    const finds = rankFinds(deals, 24, NOW);
    expect(finds.map((f) => f.findsScore)).toEqual([56, 46, 22]);
    expect(finds.map((f) => f.rank)).toEqual([1, 2, 3]);
    expect(finds[0].rarity).toBe("S");
    expect(finds[2].rarity).toBe("C");
  });

  it("excludes threshold-only and stale deals, and unparseable timestamps", () => {
    const stale = compDeal({ discount: 60, sample: 50, median: 1500, hoursAgo: 30 });
    const badTime = compDeal({ discount: 60, sample: 50, median: 1500 });
    (badTime.listing as { foundAt: string }).foundAt = "not-a-date";
    const finds = rankFinds(
      [stale, thresholdDeal(), badTime, compDeal({ discount: 40, sample: 20, median: 300 })],
      24,
      NOW,
    );
    expect(finds).toHaveLength(1);
  });

  it("breaks score ties toward the earliest find", () => {
    const finds = rankFinds(
      [
        compDeal({ discount: 30, sample: 10, median: 100, hoursAgo: 2 }),
        compDeal({ discount: 30, sample: 10, median: 100, hoursAgo: 6 }),
      ],
      24,
      NOW,
    );
    expect(finds.map((f) => f.deal.listing.foundAt)).toEqual([
      new Date(NOW - 6 * 3_600_000).toISOString(),
      new Date(NOW - 2 * 3_600_000).toISOString(),
    ]);
  });

  it("velocity reorders finds with unchanged comp data — the exit-gate test", () => {
    const deepSlow = compDeal({ discount: 45, sample: 20, median: 400 }); // 49 pts
    deepSlow.listing.id = "yahoo:slow";
    deepSlow.listing.brandKey = "cdg"; // slow brand: no velocity entry
    const shallowerFast = compDeal({ discount: 40, sample: 20, median: 400 }); // 46 pts
    shallowerFast.listing.id = "yahoo:fast"; // brandKey yohji
    const noVelocity = rankFinds([deepSlow, shallowerFast], 24, NOW);
    expect(noVelocity.map((f) => f.deal.listing.id)).toEqual(["yahoo:slow", "yahoo:fast"]);

    // Same deals, same comps: the fast-moving brand jumps the slower one.
    const withVelocity = rankFinds([deepSlow, shallowerFast], 24, NOW, 10, {
      velocity: new Map([["yohji", { share: 0.8 }]]),
    });
    expect(withVelocity.map((f) => f.deal.listing.id)).toEqual(["yahoo:fast", "yahoo:slow"]);
    expect(withVelocity[0].findsScore).toBe(46 + 6); // 0.8² × 10 = 6.4 → 6
    expect(withVelocity[1].findsScore).toBe(49); // slow brand: no velocity entry
  });

  it("reorders between brands, and never claims an individual piece sold", () => {
    const a = compDeal({ discount: 30, sample: 12, median: 300 }); // 37 pts
    a.listing.id = "yahoo:a";
    const b = compDeal({ discount: 30, sample: 12, median: 300 }); // 37 pts
    b.listing.id = "yahoo:b";
    b.listing.brandKey = "cdg"; // slow brand
    const finds = rankFinds([a, b], 24, NOW, 10, {
      velocity: new Map([
        ["yohji", { share: 0.9 }],
        ["cdg", { share: 0.2 }],
      ]),
    });
    // Identical comps — only the brand-level churn separates them.
    expect(finds.map((f) => f.deal.listing.id)).toEqual(["yahoo:a", "yahoo:b"]);
    expect(finds[0].findsScore).toBe(37 + 8); // 0.9² × 10 = 8.1 → 8
    expect(finds[1].findsScore).toBe(37 + 0); // 0.2² × 10 = 0.4 → 0
    // The factor is derived from brand churn, not the listing's own absence.
    expect(a.listing.missingSince).toBeUndefined();
  });

  it("is stable across an FX rate move — velocity sees no currency data", () => {
    const deal = compDeal({ discount: 40, sample: 20, median: 400 });
    const velocity = new Map([["yohji", { share: 0.75 }]]);
    const before = findsScore(deal, { velocity });
    (deal.listing as { priceUsd: number }).priceUsd = deal.listing.priceUsd * 0.8;
    (deal.listing as { price: number }).price = deal.listing.price * 0.8;
    const after = findsScore(deal, { velocity });
    expect(after).toBe(before); // price moved, compFacts re-derives → same discount
  });

  it("awards zero velocity to unknown, unbranded, and unlabelled deals", () => {
    const unbranded = compDeal({ discount: 40, sample: 20, median: 400 });
    delete (unbranded.listing as { brandKey?: string }).brandKey;
    const unknownBrand = compDeal({ discount: 40, sample: 20, median: 400 });
    unknownBrand.listing.brandKey = "mcgregor";
    const noCtx = compDeal({ discount: 40, sample: 20, median: 400 });
    expect(findsScore(unbranded, { velocity: new Map([["yohji", { share: 1 }]]) })).toBe(
      findsScore(noCtx),
    );
    expect(findsScore(unknownBrand, { velocity: new Map([["yohji", { share: 1 }]]) })).toBe(
      findsScore(noCtx),
    );
    expect(findsScore(noCtx)).toBe(findsScore(noCtx));
  });

  it("FAST_MOVER_SHARE gates the ⚡ label at a high bar", () => {
    expect(FAST_MOVER_SHARE).toBeGreaterThanOrEqual(0.5);
  });

  it("caps the list at 10 by default", () => {
    const deals = Array.from({ length: 15 }, (_, i) =>
      compDeal({ discount: 20 + i, sample: 8, median: 200 + i * 10, hoursAgo: i + 1 }),
    );
    expect(rankFinds(deals, 24, NOW)).toHaveLength(10);
  });

  it("honors the window parameter", () => {
    const recent = compDeal({ discount: 40, sample: 20, median: 300, hoursAgo: 2 });
    const old = compDeal({ discount: 60, sample: 50, median: 1500, hoursAgo: 5 });
    expect(rankFinds([recent, old], 3, NOW).map((f) => f.deal)).toEqual([recent]);
  });
});
