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
  /** Human qualifier shown in alerts (e.g. "Yohji mainline"). It must never
   *  restate `maxUsd`: the reason line already prints the cap, so a figure here
   *  would go stale the moment the cap changed. */
  note?: string;
}

const REP_EXCLUDE = ["rep", "replica", "fake", "faker", "bootleg", "盗作", "コピー"];

export const THRESHOLD_RULES: ThresholdRule[] = [
  {
    brandKey: "cdg",
    maxUsd: 120,
    excludeTerms: [...REP_EXCLUDE, "wallet", "card case", "fragrance", "perfume"],
    note: "CDG basics/mainline",
  },
  {
    brandKey: "number-nine",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Number (N)ine",
  },
  {
    brandKey: "yohji",
    maxUsd: 350,
    excludeTerms: [...REP_EXCLUDE, "belt", "tie"],
    note: "Yohji mainline",
  },
  {
    brandKey: "ys",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Y's (Yohji women's)",
  },
  {
    brandKey: "issey",
    maxUsd: 200,
    excludeTerms: [...REP_EXCLUDE, "perfume", "fragrance", "cologne"],
    note: "Issey Miyake apparel",
  },
  {
    brandKey: "raf",
    maxUsd: 400,
    excludeTerms: REP_EXCLUDE,
    note: "Raf Simons",
  },
  {
    brandKey: "undercover",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Undercover",
  },
  {
    brandKey: "undercoverism",
    maxUsd: 200,
    excludeTerms: REP_EXCLUDE,
    note: "Undercoverism",
  },
  {
    brandKey: "junya-watanabe",
    maxUsd: 300,
    excludeTerms: REP_EXCLUDE,
    note: "Junya Watanabe",
  },
  {
    brandKey: "margiela",
    maxUsd: 300,
    excludeTerms: REP_EXCLUDE,
    note: "Margiela",
  },
  {
    brandKey: "helmut-lang",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Helmut Lang",
  },
  {
    brandKey: "rick-owens",
    maxUsd: 300,
    excludeTerms: [...REP_EXCLUDE, "sneakers", "geobasket", "drkshdw tee"],
    note: "Rick Owens (leather usually worth more)",
  },
  {
    brandKey: "visvim",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Visvim",
  },
  {
    brandKey: "kapital",
    maxUsd: 180,
    excludeTerms: REP_EXCLUDE,
    note: "Kapital",
  },
  {
    brandKey: "needles",
    maxUsd: 120,
    excludeTerms: REP_EXCLUDE,
    note: "Needles/Nepenthes",
  },
  {
    brandKey: "guidi",
    maxUsd: 400,
    excludeTerms: [...REP_EXCLUDE, "wallet", "cardholder"],
    note: "Guidi leather",
  },
  {
    brandKey: "ann-d",
    maxUsd: 250,
    excludeTerms: REP_EXCLUDE,
    note: "Ann Demeulemeester",
  },
  {
    brandKey: "dries",
    maxUsd: 200,
    excludeTerms: REP_EXCLUDE,
    note: "Dries Van Noten",
  },
  {
    brandKey: "jil-sander",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Jil Sander",
  },
  {
    brandKey: "cavempt",
    maxUsd: 100,
    excludeTerms: REP_EXCLUDE,
    note: "Cav Empt",
  },
  {
    brandKey: "mm6",
    maxUsd: 120,
    excludeTerms: REP_EXCLUDE,
    note: "MM6",
  },
  {
    brandKey: "marni",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Marni",
  },
  {
    brandKey: "sacai",
    maxUsd: 150,
    excludeTerms: REP_EXCLUDE,
    note: "Sacai",
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
    note: "Nigo-era BAPE",
  },
  {
    brandKey: "evisu",
    maxUsd: 150,
    excludeTerms: [...REP_EXCLUDE, "wallet", "keychain", "pass case"],
    note: "Evisu (daicock denim, logo pieces)",
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
    note: "Supreme early-2000s (era-tagged)",
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

/** What a fired rule contributes: its parameters, not a rendered line. The
 *  caller renders the price it is actually showing (core/reasons.ts). */
export interface ThresholdMatch {
  maxUsd: number;
  note?: string;
}

/** Evaluate the threshold rule (if any) for a listing. */
export function evaluateThreshold(ctx: RuleContext): ThresholdMatch | undefined {
  if (!ctx.brandKey) return undefined;
  const rule = RULES_BY_BRAND.get(ctx.brandKey);
  if (!rule) return undefined;
  const title = ctx.title.toLowerCase();
  if (rule.excludeTerms?.some((t) => title.includes(t.toLowerCase()))) return undefined;
  if (rule.requireTerms && !rule.requireTerms.some((t) => title.includes(t.toLowerCase()))) {
    return undefined;
  }
  if (ctx.priceUsd <= rule.maxUsd) return { maxUsd: rule.maxUsd, note: rule.note };
  return undefined;
}
