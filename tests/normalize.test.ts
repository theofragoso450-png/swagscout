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

  // — Fuzzy fallback (runs only after the exact pass fails) —
  // Misspelled/split/concatenated brand names are where mislabeled — and
  // mispriced — archive listings hide.
  it("catches misspelled brand names via the fuzzy fallback", () => {
    expect(matchBrand("本人期復刻版 HERMUT LANG サスペンダー")?.brandKey).toBe("helmut-lang");
    expect(matchBrand("RICKOWENS abstract geth army")?.brandKey).toBe("rick-owens");
  });

  it("catches concatenated brand names (very common on JP listings)", () => {
    expect(matchBrand("ISSEYMIYAKE FÊTE シフォンツイスト カットソー")?.brandKey).toBe("issey");
    expect(matchBrand("COMMEdesGARCONS HOMME DEUX イージーパンツ")?.brandKey).toBe("cdg");
  });

  it("catches space-split brand names", () => {
    expect(matchBrand("UNDER COVER Tシャツ")?.brandKey).toBe("undercover");
  });

  it("accent-folds before fuzzy comparison", () => {
    // "Comme des Garçuns"-style typo on the folded alias
    expect(matchBrand("comme des garcuns tee")?.brandKey).toBe("cdg");
  });

  it("keeps short aliases exact-only (typo ambiguity)", () => {
    // "ebisu" is a place/word (Saga Ebisu sake cup) and Yebisu the beer —
    // distance-1 from evisu. The DB differential proved these false
    // positives; 5-char aliases must never fuzzy-match.
    expect(matchBrand("Saga Ebisu お猪口 ぐい飲み 陶器")).toBeUndefined();
    expect(matchBrand("Yebisu beer glasses")).toBeUndefined();
    // exact spelling still works
    expect(matchBrand("EVISU jeans 2002")?.brandKey).toBe("evisu");
  });

  it("fuzzy respects the homonym guard", () => {
    // "MARMOT CAPITAL" is outdoor gear, not Kapital — 'capital' is on
    // kapital's negative list.
    expect(matchBrand("MARMOT CAPITAL パーテックス シアージャケット")).toBeUndefined();
    // genuine Kapital still matches exactly
    expect(matchBrand("KAPITAL No.3 bootcut denim")?.brandKey).toBe("kapital");
  });

  it("never fuzzy-matches model codes, digits, or CJK windows", () => {
    expect(matchBrand("adidas F34246 デトロイトランナー")).toBeUndefined();
    expect(matchBrand("IM21-F0636-67 カーディガン")).toBeUndefined();
  });
});

describe("Y's (Yohji women's line)", () => {
  const CU = "\u2019"; // right single quotation mark

  it("matches standalone Y's titles in both apostrophe variants + kana", () => {
    expect(matchBrand("Y's ワイズ チュニック")?.brandKey).toBe("ys");
    expect(matchBrand(`Y${CU}s パンツ`)?.brandKey).toBe("ys");
    expect(matchBrand("ワイズ ロングコート")?.brandKey).toBe("ys");
  });

  it("keeps the men's line on yohji — longer aliases win", () => {
    expect(matchBrand("Y's for men フラップ ポケット ブルゾン")?.brandKey).toBe("yohji");
    // curly-apostrophe "y’s for men": without this yohji alias the title
    // falls through to the 3-char "y’s" ys alias — wrong sub-line.
    expect(matchBrand(`Y${CU}s for men ブルゾン`)?.brandKey).toBe("yohji");
  });

  it("never matches genitives or the bare ys substring", () => {
    // "tommy's"/"sony's" contain "y's" — homonym guard must fire
    expect(matchBrand("tommy's jeans デニム")).toBeUndefined();
    expect(matchBrand(`sony${CU}s デジカメ`)).toBeUndefined();
    // bare "ys" would hit "boys"/"toys" — deliberately not an alias
    expect(matchBrand("boys トーク")).toBeUndefined();
    expect(matchBrand("toy shop")).toBeUndefined();
  });
});

describe("extractSize", () => {
  // — Branch 1: letter sizes (S/M/L/XS/XL/XXL), first match wins —
  it("finds letter sizes and normalizes case", () => {
    expect(extractSize("jacket size L")).toBe("L");
    expect(extractSize("シャツ M")).toBe("M");
    expect(extractSize("hoodie xl")).toBe("XL");
    expect(extractSize("xxl hoodie")).toBe("XXL");
    expect(extractSize("XS tee")).toBe("XS");
    expect(extractSize("スニーカー SIZE M")).toBe("M");
  });

  // Branch 1 must not fire on letters inside words (\b…\b)
  it("does not match letter fragments inside words", () => {
    expect(extractSize("levi's 501 denim")).toBeUndefined();
    expect(extractSize("sample sale item")).toBeUndefined();
    expect(extractSize("charm necklace")).toBeUndefined();
  });

  // — Branch 2: single digit 1–7 (JP shirt sizes) —
  it("finds single-digit sizes 1-7", () => {
    expect(extractSize("undercover パーカー サイズ2")).toBe("2");
    expect(extractSize("yohji shirt size 4")).toBe("4");
    expect(extractSize("サイズ1")).toBe("1");
    expect(extractSize("number 9 shirt")).toBeUndefined(); // 8-9 out of range
  });

  // — Branch 3: W## / waist ## —
  it("finds waist sizes before generic digits", () => {
    expect(extractSize("W32 denim")).toBe("W32");
    expect(extractSize("pants w34 blue")).toBe("W34");
    expect(extractSize("waist 34 slacks")).toBe("WAIST 34");
  });

  // — Branch 4: two-digit sizes (EU/JP numeric) —
  it("finds two-digit sizes including zero-padded", () => {
    expect(extractSize("size 38 dress")).toBe("38");
    expect(extractSize("denim 06")).toBe("06");
    expect(extractSize("size 00 jacket")).toBe("00");
    expect(extractSize("コムデギャルソン 46")).toBe("46");
  });

  it("rejects one-, three-digit, and model-code numbers", () => {
    expect(extractSize("adidas F34246 デトロイトランナー")).toBeUndefined();
    expect(extractSize("model A1355")).toBeUndefined();
    expect(extractSize("price 15000 yen")).toBeUndefined();
  });

  // DEFECT (red): the single-digit branch steals the fraction from real
  // decimal sizes — "US 10.5" must be 10.5, not 5.
  it("extracts decimal shoe sizes instead of the fraction digit", () => {
    expect(extractSize("US 10.5 sneaker")).toBe("10.5");
    expect(extractSize("sneaker 27.5")).toBe("27.5");
  });

  // New Era cap sizes run 6⅞-8+ with up to three decimals; US shoe
  // halves (8.5) and JP half-digit fractions (9.5-13.5) are single-digit
  // decimals — but bare 8/9 and "1.5ml" samples stay non-sizes.
  it("extracts single-digit decimal sizes (6-9) only", () => {
    expect(extractSize("supreme cap size 7.375")).toBe("7.375");
    expect(extractSize("ビズビム サイズ:8.5" )).toBe("8.5");
    expect(extractSize("レプリカ 1.5ml"))
      .toBeUndefined();
    expect(extractSize("case 8 only")).toBeUndefined();
  });

  // DEFECT (red): cm-suffixed shoe sizes appear throughout the live data
  // ("Size25cm", "27cm", "40CM") but extract nothing today.
  it("extracts cm-suffixed shoe sizes", () => {
    expect(extractSize("Size25cm ローカット")).toBe("25CM");
    expect(extractSize("スニーカー 27cm")).toBe("27CM");
    expect(extractSize("40CM シルバー ネックレス")).toBe("40CM");
  });

  // Style codes must not become sizes (live junk: "M-1柄" → M,
  // "IM21-F0636-67" → 67, "CI1303406" → 1).
  it("rejects style-code and catalog fragments", () => {
    expect(extractSize("M-1柄ジャケット")).toBeUndefined();
    expect(extractSize("IM21-F0636-67")).toBeUndefined();
    expect(extractSize("CI1303406 ナンバーナイン")).toBeUndefined();
    expect(extractSize("UCY4101-2 パーカー")).toBeUndefined();
  });

  // Hyphenated letter sizes are real (live DB), unlike M-1 pattern names.
  it("accepts hyphenated letter sizes", () => {
    expect(extractSize("Size-XL hoodie")).toBe("XL");
    expect(extractSize("L-XL キャップ")).toBe("L");
  });

  it("returns undefined for titles without any size signal", () => {
    expect(extractSize("ヘルムートラング トリプルレイヤードチェーンネックレス シルバー")).toBeUndefined();
    expect(extractSize("")).toBeUndefined();
  });

  // End-to-end: normalizeListing falls back to extractSize when the
  // adapter passes no explicit size (all markets except Grailed).
  it("feeds normalizeListing when the adapter passes no explicit size", () => {
    const l = normalizeListing({ ...base, title: "ヨウジヤマモト シャツ サイズ3" });
    expect(l.size).toBe("3");
    const g = normalizeListing({ ...base, title: "whatever", size: "XL" });
    expect(g.size).toBe("XL"); // explicit size wins
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

  it("does not read 'unused' as used (lookbehind)", () => {
    expect(extractCondition("UNUSED Raf Simons jacket")).toBe("new");
    expect(extractCondition("never used once Yohji shirt")).toBe("new");
    expect(extractCondition("un-used CDG coat")).toBe("new");
    expect(extractCondition("genuinely used Rick Owens tee")).toBe("used");
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
