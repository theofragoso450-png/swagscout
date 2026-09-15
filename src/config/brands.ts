/**
 * Curated archive-fashion brand catalog, modeled on the SwagSearch watchlist
 * (CDG, Number Nine, Yohji, Issey, Raf, Undercover, 30+ more).
 *
 * Each brand carries English/romaji aliases (for Western markets) and
 * Japanese-script aliases (for Yahoo / Mercari / Rakuma matching).
 */

export interface Brand {
  /** stable slug used in rules, store, commands */
  key: string;
  name: string;
  /** English/romaji match terms (case-insensitive substring match). */
  aliases: string[];
  /** Japanese-script match terms for JP marketplaces. */
  jpAliases?: string[];
  /** Homonym guard: a title containing any of these never matches this brand
   *  (e.g. ベイプ also means "vape" in Japanese). */
  negativeJpAliases?: string[];
  /** Terms searched verbatim on JP marketplaces (usually Japanese). */
  searchTerms: string[];
}

export const BRANDS: Brand[] = [
  {
    key: "cdg",
    name: "Comme des Garçons",
    aliases: ["comme des garcons", "comme des garçons", "cdg", "cdg play"],
    jpAliases: ["コムデギャルソン", "コム ザ デ ギャルソン"],
    searchTerms: ["コムデギャルソン", "cdg"],
  },
  {
    key: "number-nine",
    name: "Number (N)ine",
    aliases: ["number (n)ine", "number nine", "number(n)ine", "(n)ine", "number nine takahiro miyashita"],
    jpAliases: ["ナンバーナイン", "ナンバー ナイン"],
    searchTerms: ["ナンバーナイン"],
  },
  {
    key: "yohji",
    name: "Yohji Yamamoto",
    aliases: ["yohji yamamoto", "yohji", "y's for men", "yohji yamamoto pour homme", "s'yte", "regulation yohji"],
    jpAliases: ["ヨウジヤマモト", "ヨウジヤマモト プアオム", "洋裁山本"],
    searchTerms: ["ヨウジヤマモト", "yohji"],
  },
  {
    key: "issey",
    name: "Issey Miyake",
    aliases: ["issey miyake", "issei miyake", "pleats please", "homme plisse", "ba bao", "im product"],
    jpAliases: ["イッセイミヤケ", "イッセイ ミヤケ", "プレイツ プリーズ"],
    searchTerms: ["イッセイミヤケ", "issey miyake"],
  },
  {
    key: "raf",
    name: "Raf Simons",
    aliases: ["raf simons", "raf by raf simons", "calvin klein 205w39nyc", "ck205"],
    jpAliases: ["ラフシモンズ", "ラフ シモンズ"],
    searchTerms: ["ラフシモンズ", "raf simons"],
  },
  {
    key: "undercover",
    name: "Undercover",
    aliases: ["undercover", "undercoverism", "uc1b2a3", "undercover lab"],
    jpAliases: ["アンダーカバー", "アンダーカバー イズム"],
    searchTerms: ["アンダーカバー"],
  },
  {
    key: "helmut-lang",
    name: "Helmut Lang",
    aliases: ["helmut lang", "helmut", "hlang"],
    jpAliases: ["ヘルムートラング"],
    searchTerms: ["ヘルムートラング", "helmut lang"],
  },
  {
    key: "rick-owens",
    name: "Rick Owens",
    aliases: ["rick owens", "drkshdw", "rick owens drkshdw"],
    jpAliases: ["リックオウエンス", "リック オウエンス", "DRKSHDW"],
    searchTerms: ["リックオウエンス", "rick owens"],
  },
  {
    key: "junya-watanabe",
    name: "Junya Watanabe",
    aliases: ["junya watanabe", "junya", "junya watanabe man"],
    jpAliases: ["ジュンヤワタナベ", "ジュンヤ ワタナベ"],
    searchTerms: ["ジュンヤワタナベ"],
  },
  {
    key: "margiela",
    name: "Maison Margiela",
    aliases: ["maison margiela", "margiela", "maison martin margiela", "line 6", "line 10"],
    jpAliases: ["メゾン マルタン マルジェラ", "メゾンマルジェラ", "マルジェラ"],
    searchTerms: ["マルジェラ", "margiela"],
  },
  {
    key: "goose",
    name: "Golden Goose Deluxe Brand",
    aliases: ["golden goose", "ggdb"],
    jpAliases: ["ゴールデングース"],
    searchTerms: ["ゴールデングース"],
  },
  {
    key: "sacai",
    name: "Sacai",
    aliases: ["sacai"],
    jpAliases: ["サカイ"],
    searchTerms: ["サカイ"],
  },
  {
    key: "undercoverism",
    name: "Undercoverism",
    aliases: ["undercoverism"],
    jpAliases: ["アンダーカバーイズム"],
    searchTerms: ["アンダーカバーイズム"],
  },
  {
    key: "visvim",
    name: "Visvim",
    aliases: ["visvim", "wmv", "visvim fbt", "visvim skagway"],
    jpAliases: ["ビズビム"],
    searchTerms: ["ビズビム"],
  },
  {
    key: "kapital",
    name: "Kapital",
    aliases: ["kapital", "kaptain sunshine", "capitar"],
    jpAliases: ["カピタル", "KAPITAL"],
    searchTerms: ["KAPITAL", "カピタル"],
  },
  {
    key: "needles",
    name: "Needles",
    aliases: ["needles", "nepenthes", "south2 west8", "engineered garments"],
    jpAliases: ["ニードルズ", "ネペンテス"],
    searchTerms: ["ニードルズ"],
  },
  {
    key: "bape",
    name: "BAPE (Nigo era)",
    aliases: [
      "a bathing ape",
      "bathing ape",
      "bape",
      "bapesta",
      "bape sta",
      "baby milo",
      "ape shall never kill ape",
      "nigo",
    ],
    jpAliases: ["ベイプ", "ア ベイシング エイプ", "エイプ"],
    // ベイプ/エイプ are ordinary Japanese words (vape / ape) — reject e-cig
    // liquid and animal-listing noise before it gets stored as BAPE.
    negativeJpAliases: [
      "ドクターベイプ",
      "dr.vape",
      "dr vape",
      "vape",
      "電子タバコ",
      "タバコ",
      "リキッド",
      "プルームテック",
      "アイコス",
      "ゴリラ",
    ],
    searchTerms: ["ベイプ", "bape"],
  },
  {
    key: "evisu",
    name: "Evisu",
    aliases: ["evisu", "evisu genes", "evisu collection", "evisu no.1"],
    jpAliases: ["エヴィス", "エビス ジーンズ"],
    searchTerms: ["エヴィス", "evisu"],
  },
  {
    key: "supreme",
    name: "Supreme (early 2000s)",
    aliases: ["supreme", "supreme nyc", "supreme new york"],
    jpAliases: ["シュプリーム"],
    // "Supreme Being" is an unrelated UK brand; Pflueger "Supreme" is a
    // fishing-reel line (vintage ones even say "vintage"); reps are rampant.
    negativeJpAliases: [
      "supreme being",
      "supremebeing",
      "replica",
      "pflueger",
      "fishing",
      "リール",
      "釣り",
      "釣竿",
      "south bend",
      "reel",
    ],
    // Broad terms feed the comp engine; era-qualified terms target the archive.
    searchTerms: ["supreme", "シュプリーム", "シュプリーム 00s", "supreme vintage"],
  },
  {
    key: "nmber-nine-women",
    name: "Number (N)ine Women",
    aliases: ["number nine women"],
    jpAliases: ["ナンバーナイン レディース"],
    searchTerms: ["ナンバーナイン レディース"],
  },
  {
    key: "jil-sander",
    name: "Jil Sander",
    aliases: ["jil sander", "jil sander navy"],
    jpAliases: ["ジルサンダー"],
    searchTerms: ["ジルサンダー"],
  },
  {
    key: "marni",
    name: "Marni",
    aliases: ["marni"],
    jpAliases: ["マルニ"],
    searchTerms: ["マルニ", "marni"],
  },
  {
    key: "dries",
    name: "Dries Van Noten",
    aliases: ["dries van noten", "dries", "dvn"],
    jpAliases: ["ドリスヴァンノッテン", "ドリス ヴァン ノッテン"],
    searchTerms: ["ドリスヴァンノッテン", "dries van noten"],
  },
  {
    key: "ann-d",
    name: "Ann Demeulemeester",
    aliases: ["ann demeulemeester", "ann d"],
    jpAliases: ["アンドゥムールメステール", "アン デムルメステール"],
    searchTerms: ["アンドゥムールメステール", "ann demeulemeester"],
  },
  {
    key: "guidi",
    name: "Guidi",
    aliases: ["guidi"],
    jpAliases: ["グイディ"],
    searchTerms: ["グイディ"],
  },
  {
    key: "julius",
    name: "Julius",
    aliases: ["julius"],
    jpAliases: ["ユリウス"],
    searchTerms: ["ユリウス"],
  },
  {
    key: "the-viridi-anne",
    name: "The Viridi-anne",
    aliases: ["the viridi anne", "viridi anne"],
    jpAliases: ["ヴィリディアン", "ザ ヴィリディアン"],
    searchTerms: ["ヴィリディアン"],
  },
  {
    key: "song-for-the-mute",
    name: "Song for the Mute",
    aliases: ["song for the mute"],
    jpAliases: ["ソングフォーザミュート"],
    searchTerms: ["song for the mute"],
  },
  {
    key: "atacama",
    name: "Atacama",
    aliases: ["atacama"],
    jpAliases: ["アタカマ"],
    searchTerms: ["アタカマ"],
  },
  {
    key: "attachment",
    name: "Attachment",
    aliases: ["attachment"],
    jpAliases: ["アタッチメント"],
    searchTerms: ["アタッチメント"],
  },
  {
    key: "beautiful-people",
    name: "Beautiful People",
    aliases: ["beautiful people"],
    jpAliases: ["ビューティフルピープル"],
    searchTerms: ["ビューティフルピープル"],
  },
  {
    key: "bless",
    name: "Bless",
    aliases: ["bless"],
    jpAliases: ["ブレス"],
    searchTerms: ["bless"],
  },
  {
    key: "cavempt",
    name: "Cav Empt (C.E)",
    aliases: ["cav empt", "cavempt", "c.e", "ce cvntrstnd"],
    jpAliases: ["カブエンプト"],
    searchTerms: ["Cav Empt", "セーブエンプト"],
  },
  {
    key: "mm6",
    name: "MM6 Maison Margiela",
    aliases: ["mm6"],
    jpAliases: ["MM6"],
    searchTerms: ["MM6"],
  },
  {
    key: "number-nine-accessories",
    name: "Number (N)ine Accessories",
    aliases: ["number nine accessories"],
    jpAliases: ["ナンバーナイン アクセサリー"],
    searchTerms: ["ナンバーナイン アクセサリー"],
  },
  {
    key: "raf-summer",
    name: "Raf Simons (archival seasonal)",
    aliases: ["raf simons archival"],
    jpAliases: ["ラフシモンズ アーカイブ"],
    searchTerms: ["ラフシモンズ アーカイブ"],
  },
  {
    key: "yohji-sense",
    name: "Yohji Yamamoto + Noir",
    aliases: ["yohji yamamoto noir", "noir yohji"],
    jpAliases: ["ヨウジヤマモト ノワール"],
    searchTerms: ["ヨウジヤマモト ノワール"],
  },
  {
    key: "issey-perfumes",
    name: "Issey Miyake (apparel archive)",
    aliases: ["issey miyake homme", "im homme"],
    jpAliases: ["イッセイミヤケ オム"],
    searchTerms: ["イッセイミヤケ オム"],
  },
];

export const BRAND_BY_KEY: Map<string, Brand> = new Map(BRANDS.map((b) => [b.key, b]));

/** All alias→brandKey pairs, longest first so "cdg play" wins over "cdg". */
export interface AliasEntry {
  alias: string;
  brandKey: string;
  isJp: boolean;
}

export const ALIAS_INDEX: AliasEntry[] = BRANDS.flatMap((b) => [
  ...b.aliases.map((a) => ({ alias: a.toLowerCase(), brandKey: b.key, isJp: false })),
  ...(b.jpAliases ?? []).map((a) => ({ alias: a.toLowerCase(), brandKey: b.key, isJp: true })),
]).sort((a, b) => b.alias.length - a.alias.length);

/** Try to identify a brand in a free-text listing title. */
export function matchBrand(title: string): { brandKey: string; matched: string } | undefined {
  const t = title.toLowerCase();
  for (const entry of ALIAS_INDEX) {
    if (!t.includes(entry.alias)) continue;
    // Homonym guard: skip this brand if the title hits a negative term.
    const brand = BRAND_BY_KEY.get(entry.brandKey);
    if (brand?.negativeJpAliases?.some((n) => t.includes(n.toLowerCase()))) continue;
    return { brandKey: entry.brandKey, matched: entry.alias };
  }
  return undefined;
}

export function getBrand(key: string): Brand | undefined {
  return BRAND_BY_KEY.get(key);
}
