import { describe, expect, it } from "vitest";
import {
  normalizeListing,
  extractSize,
  cleanTitle,
  canonicalKey,
} from "../src/core/normalize.js";
import { matchBrand } from "../src/config/brands.js";
import { evaluateThreshold } from "../src/config/rules.js";
import { extractCondition } from "../src/core/normalize.js";

const base = {
  market: "yahoo" as const,
  currency: "JPY" as const,
  url: "https://auctions.yahoo.co.jp/jp/auction/n1",
};

describe("matchBrand", () => {
  it("matches English aliases case-insensitively", () => {
    expect(matchBrand("Raf Simons 2005AW jacket")?.brandKey).toBe("raf");
    expect(matchBrand("rick owens geobasket")?.brandKey).toBe("rick-owens");
    expect(matchBrand("Yohji Yamamoto POUR HOMME shirt")?.brandKey).toBe("yohji");
  });

  it("matches Japanese aliases", () => {
    expect(matchBrand("ヨウジヤマモト シャツ")?.brandKey).toBe("yohji");
    expect(matchBrand("コムデギャルソン Tシャツ")?.brandKey).toBe("cdg");
    expect(matchBrand("アンダーカバー パーカー")?.brandKey).toBe("undercover");
  });

  it("matches BAPE (Nigo era) in EN and JP", () => {
    expect(matchBrand("BAPE STA sneakers 2003")?.brandKey).toBe("bape");
    expect(matchBrand("A Bathing Ape baby milo tee")?.brandKey).toBe("bape");
    expect(matchBrand("ベイプ パーカー")?.brandKey).toBe("bape");
  });

  it("rejects vape/e-cig noise from BAPE matches (homonym guard)", () => {
    expect(matchBrand("電子タバコ用 ベイプ リキッド プルームテック")).toBeUndefined();
    expect(matchBrand("ドクターベイプ DR.VAPE model3")).toBeUndefined();
    // real BAPE still matches alongside innocuous text
    expect(matchBrand("ベイプ BAPE STA 2004")?.brandKey).toBe("bape");
  });

  it("matches Evisu in EN and JP", () => {
    expect(matchBrand("Evisu No.1 Special jeans daicock")?.brandKey).toBe("evisu");
    expect(matchBrand("エヴィス ジーンズ")?.brandKey).toBe("evisu");
  });

  it("matches Supreme in EN and JP", () => {
    expect(matchBrand("Supreme box logo tee 2003")?.brandKey).toBe("supreme");
    expect(matchBrand("シュプリーム 00s パーカー")?.brandKey).toBe("supreme");
  });

  it("rejects Supreme Being (unrelated UK brand) via homonym guard", () => {
    expect(matchBrand("Supreme Being tee")).toBeUndefined();
    expect(matchBrand("supremebeing uk")).toBeUndefined();
  });

  it("rejects Pflueger Supreme fishing gear (era word 'vintage' must not rescue it)", () => {
    // Regression: this exact live title fired a false $35 supreme deal.
    const t = "VINTAGE PFLUEGER SUPREME ダイレクトリール フルーガー";
    expect(matchBrand(t)).toBeUndefined();
  });

  it("does not match Yebisu beer as Evisu", () => {
    expect(matchBrand("エビスビール 缶")?.brandKey).toBeUndefined();
  });

  it("prefers longer aliases", () => {
    // "cdg play" is longer than "cdg" — either way it maps to cdg brand
    expect(matchBrand("CDG Play heart tee")?.brandKey).toBe("cdg");
  });

  it("returns undefined for unknown brands", () => {
    expect(matchBrand("random unbranded hoodie")).toBeUndefined();
  });
});

describe("extractSize", () => {
  it("finds letter sizes", () => {
    expect(extractSize("jacket size L")).toMatch(/L/i);
    expect(extractSize("シャツ M")).toMatch(/M/i);
  });

  it("finds numeric sizes", () => {
    expect(extractSize("undercover パーカー サイズ2")).toMatch(/2/);
  });
});

describe("cleanTitle", () => {
  it("strips JP noise words", () => {
    const cleaned = cleanTitle("ヨウジヤマモト シャツ 中古 美品 送料込み");
    expect(cleaned).not.toContain("中古");
    expect(cleaned).not.toContain("美品");
    expect(cleaned).not.toContain("送料");
  });
});

describe("normalizeListing", () => {
  it("converts JPY to USD", () => {
    const l = normalizeListing({ ...base, id: "x1", title: "test", price: 15500 });
    expect(l.priceUsd).toBeCloseTo(100, 0);
  });

  it("passes USD through", () => {
    const l = normalizeListing({
      market: "grailed",
      id: "g1",
      title: "raf simons tee",
      price: 100,
      currency: "USD",
      url: "https://www.grailed.com/listings/1",
    });
    expect(l.priceUsd).toBe(100);
  });
});

describe("normalizeListing → threshold pipeline", () => {
  it("keeps 'vintage' (an era signal for the supreme gate) in stored titles", () => {
    // Regression: cleanTitle used to strip "vintage" as price noise, so a
    // lowercase Yahoo title failed the supreme era gate while the same
    // title with a capital V passed.
    const l = normalizeListing({
      ...base,
      id: "era1",
      title: "supreme vintage 5-panel camp cap",
      price: 8000,
    });
    expect(l.title).toContain("vintage");
    expect(
      evaluateThreshold({ brandKey: l.brandKey, title: l.title, priceUsd: l.priceUsd }),
    ).toBeDefined();
  });

  it("still strips genuine price-inflation noise words", () => {
    const l = normalizeListing({ ...base, id: "n1", title: "中古 美品 送料込み", price: 1000 });
    expect(l.title).not.toContain("中古");
  });
});

describe("extractCondition", () => {
  it("detects new-condition markers (JP + EN)", () => {
    expect(extractCondition("新品同様 Yohji Yamamoto シャツ")).toBe("new");
    expect(extractCondition("未使用 ISSEY MIYAKE ワンピース")).toBe("new");
    expect(extractCondition("Raf Simons jacket DEADSTOCK")).toBe("new");
  });

  it("detects like-new markers", () => {
    expect(extractCondition("美品 COMME des GARCONS カーディガン")).toBe("like-new");
    expect(extractCondition("良品 number (n)ine パーカー")).toBe("like-new");
  });

  it("detects used markers", () => {
    expect(extractCondition("中古 Rick Owens レザージャケット")).toBe("used");
    expect(extractCondition("Yohji Yamamoto used shirt")).toBe("used");
    expect(extractCondition("CDG pre-owned bag")).toBe("used");
  });

  it("returns undefined when no marker is present", () => {
    expect(extractCondition("PLAY COMME des GARCONS Tシャツ L")).toBeUndefined();
    expect(extractCondition("")).toBeUndefined();
  });

  it("extractCondition flows into normalized listings from the raw title", () => {
    const l = normalizeListing({ ...base, id: "c1", title: "美品 ヨウジヤマモト シャツ", price: 1000 });
    expect(l.condition).toBe("like-new");
    expect(l.title).not.toContain("美品"); // cleaned from display title
  });

  it("prioritizes the best condition when several markers coexist", () => {
    expect(extractCondition("中古だが未使用 tags attached")).toBe("new");
    expect(extractCondition("used だが美品")).toBe("like-new");
  });
});

describe("canonicalKey", () => {
  it("prefixes the brand slug", () => {
    const l = normalizeListing({ ...base, id: "x2", title: "ヨウジヤマモト シャツ", price: 1000 });
    expect(canonicalKey(l)).toMatch(/^yohji\|/);
  });

  it("is stable across noise-word differences", () => {
    const a = normalizeListing({ ...base, id: "a", title: "ラフシモンズ ジャケット 2005AW", price: 1000 });
    const b = normalizeListing({ ...base, id: "b", title: "ラフシモンズ ジャケット 2005AW 中古 美品", price: 1200 });
    expect(canonicalKey(a)).toBe(canonicalKey(b));
  });
});
