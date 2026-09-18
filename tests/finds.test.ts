import { describe, expect, it } from "vitest";
import { findsScore, parseCompReason, classifyRarity, rankFinds } from "../src/notify/finds.js";
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

describe("parseCompReason", () => {
  it("extracts discount, sample size, and median from the comp reason text", () => {
    expect(parseCompReason(compDeal({ discount: 39.5, sample: 22, median: 420 }).reasons)).toEqual({
      discountPct: 39.5,
      sampleSize: 22,
      medianUsd: 420,
    });
  });

  it("returns null for threshold-only deals", () => {
    expect(parseCompReason(thresholdDeal().reasons)).toBeNull();
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
