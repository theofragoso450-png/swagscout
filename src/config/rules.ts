/**
 * Default per-brand price-threshold rules.
 *
 * A listing triggers a "threshold" deal when:
 *  - its brand key is listed here, and
 *  - its USD price is <= maxUsd, and
 *  - none of its `excludeTerms` appear in the title (e.g. "rep", "faker"),
 *  - and, if `requireTerms` is set, at least one of them appears.
 *
 * Override or extend by editing this file — thresholds are intentionally
 * boring and predictable. Cross-market comps add a second, smarter layer
 * on top (see core/comps.ts).
 */

export interface ThresholdRule {
  brandKey: string;
  /** Alert when priceUsd <= maxUsd. */
  maxUsd: number;
  /** Skip listings whose title contains any of these (case-insensitive). */
  excludeTerms?: string[];
  /** If set, the title must contain at least one of these. */
  requireTerms?: string[];
  /** Human note shown in alerts. */
  note?: string;
}

const REP_EXCLUDE = ["rep", "replica", "fake", "faker", "bootleg", "盗作", "コピー"];

export const THRESHOLD_RULES: ThresholdRule[] = [
  {
    brandKey: "cdg",
    maxUsd: 120,
    excludeTerms: [...REP_EXCLUDE, "wallet", "card case", "fragrance", "perfume"],
    note: "CDG basics/mainline under $120",
  },
  {
    brandKey: "number-nine",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Number (N)ine under $250",
  },
  {
    brandKey: "yohji",
    maxUsd: 350,
    excludeTerms: [...REP_EXCLUDE, "belt", "tie"],
    note: "Yohji mainline under $350",
  },
  {
    brandKey: "issey",
    maxUsd: 200,
    excludeTerms: [...REP_EXCLUDE, "perfume", "fragrance", "cologne"],
    note: "Issey Miyake apparel under $200",
  },
  {
    brandKey: "raf",
    maxUsd: 400,
    excludeTerms: REP_EXCLUDE,
    note: "Raf Simons under $400",
  },
  {
    brandKey: "undercover",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Undercover under $250",
  },
  {
    brandKey: "undercoverism",
    maxUsd: 200,
    excludeTerms: REP_EXCLUDE,
    note: "Undercoverism under $200",
  },
  {
    brandKey: "junya-watanabe",
    maxUsd: 300,
    excludeTerms: REP_EXCLUDE,
    note: "Junya Watanabe under $300",
  },
  {
    brandKey: "margiela",
    maxUsd: 300,
    excludeTerms: REP_EXCLUDE,
    note: "Margiela under $300",
  },
  {
    brandKey: "helmut-lang",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Helmut Lang under $150",
  },
  {
    brandKey: "rick-owens",
    maxUsd: 300,
    excludeTerms: [...REP_EXCLUDE, "sneakers", "geobasket", "drkshdw tee"],
    note: "Rick Owens under $300 (leather usually worth more)",
  },
  {
    brandKey: "visvim",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Visvim under $250",
  },
  {
    brandKey: "kapital",
    maxUsd: 180,
    excludeTerms: REP_EXCLUDE,
    note: "Kapital under $180",
  },
  {
    brandKey: "needles",
    maxUsd: 120,
    excludeTerms: REP_EXCLUDE,
    note: "Needles/Nepenthes under $120",
  },
  {
    brandKey: "guidi",
    maxUsd: 400,
    excludeTerms: [...REP_EXCLUDE, "wallet", "cardholder"],
    note: "Guidi leather under $400",
  },
  {
    brandKey: "ann-d",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Ann Demeulemeester under $250",
  },
  {
    brandKey: "dries",
    maxUsd: 200,
    excludeTerms: REP_EXCLUDE,
    note: "Dries Van Noten under $200",
  },
  {
    brandKey: "jil-sander",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Jil Sander under $150",
  },
  {
    brandKey: "cavempt",
    maxUsd: 100,
    excludeTerms: REP_EXCLUDE,
    note: "Cav Empt under $100",
  },
  {
    brandKey: "mm6",
    maxUsd: 120,
    excludeTerms: REP_EXCLUDE,
    note: "MM6 under $120",
  },
  {
    brandKey: "marni",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Marni under $150",
  },
  {
    brandKey: "sacai",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Sacai under $150",
  },
  {
    brandKey: "bape",
    maxUsd: 180,
    // ベイプ also means "vape" in Japanese — filter e-cigarette noise
    excludeTerms: [
      ...REP_EXCLUDE,
      "wallet",
      "keychain",
      "vape",
      "vapor",
      "電子タバコ",
      "タバコ",
      "リキッド",
      "プルームテック",
      "アイコス",
      "ドクターベイプ",
      "dr.vape",
    ],
    note: "Nigo-era BAPE under $180",
  },
  {
    brandKey: "evisu",
    maxUsd: 150,
    excludeTerms: [...REP_EXCLUDE, "wallet", "keychain", "pass case"],
    note: "Evisu (daicock denim, logo pieces) under $150",
  },
  {
    brandKey: "supreme",
    maxUsd: 250,
    // Era-gated: only fire on titles tagged with early-2000s markers
    // (year/season codes, box logo, vintage wording). Untagged modern
    // Supreme still flows through the cross-market comp engine.
    requireTerms: [
      "00s", "01s", "02s", "03s", "04s", "05s",
      "2001", "2002", "2003", "2004", "2005",
      "ss01", "ss02", "ss03", "ss04", "ss05",
      "fw01", "fw02", "fw03", "fw04", "fw05",
      "aw01", "aw02", "aw03", "aw04", "aw05",
      "box logo", "bogo", "vintage",
      "オールド", "ビンテージ", "ヴィンテージ", "00年代", "90年代", "2000年代",
    ],
    excludeTerms: [
      ...REP_EXCLUDE,
      "sticker",
      "keychain",
      "lace lock",
      "ショッパー", // vintage paper shopping bags
      "紙袋",
    ],
    note: "Supreme early-2000s (era-tagged) under $250",
  },
];

export const RULES_BY_BRAND: Map<string, ThresholdRule> = new Map(
  THRESHOLD_RULES.map((r) => [r.brandKey, r]),
);

export interface RuleContext {
  brandKey?: string;
  title: string;
  priceUsd: number;
}

/** Evaluate the threshold rule (if any) for a listing. Returns detail or undefined. */
export function evaluateThreshold(ctx: RuleContext): string | undefined {
  if (!ctx.brandKey) return undefined;
  const rule = RULES_BY_BRAND.get(ctx.brandKey);
  if (!rule) return undefined;
  const title = ctx.title.toLowerCase();
  if (rule.excludeTerms?.some((t) => title.includes(t.toLowerCase()))) return undefined;
  if (rule.requireTerms && !rule.requireTerms.some((t) => title.includes(t.toLowerCase()))) {
    return undefined;
  }
  if (ctx.priceUsd <= rule.maxUsd) {
    const note = rule.note ? ` — ${rule.note}` : "";
    return `price $${ctx.priceUsd.toFixed(0)} ≤ $${rule.maxUsd}${note}`;
  }
  return undefined;
}
