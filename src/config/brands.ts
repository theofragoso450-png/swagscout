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
    aliases: ["yohji yamamoto", "yohji", "y's for men", "y’s for men", "yohji yamamoto pour homme", "s'yte", "regulation yohji"],
    jpAliases: ["ヨウジヤマモト", "ヨウジヤマモト プアオム", "洋裁山本"],
    searchTerms: ["ヨウジヤマモト", "yohji"],
  },
  {
    key: "ys",
    name: "Y's (Yohji Yamamoto women's)",
    // NB: deliberately no bare "ys" alias — the substring would hit "boys"/
    // "toys". Only apostrophe forms match. "y's for men" (yohji) is longer
    // than "y's" and so keeps winning on those titles via index order.
    aliases: ["y's", "y’s"],
    jpAliases: ["ワイズ"],
    // Genitive guard: "tommy's"/"sony's" contain "y's"; real Y's titles never
    // mention those words (0 such collisions in the live corpus).
    negativeJpAliases: ["tommy's", "tommy’s", "sony's", "sony’s"],
    searchTerms: ["ヨウジヤマモト"],
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
    // "CAPITAL" is an ordinary English word (outdoor-gear titles like
    // "MARMOT CAPITAL") — the fashion brand is never spelled that way.
    negativeJpAliases: ["capital"],
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
  // Exact match failed — badly-listed items (misspelled brands) are where
  // some of the best deals hide, so fall back to typo-tolerant matching.
  return matchBrandFuzzy(t);
}

// ---------------------------------------------------------------------------
// Fuzzy fallback (runs only after the exact substring pass failed).
//
// Design constraints, learned from the live data:
//  - compare whole WORD WINDOWS (1-3 consecutive ASCII-letter words), never
//    raw substrings — a fuzzy "cdg" inside "cdgaf" or inside a model code
//    would be garbage
//  - window tokens with digits or non-latin script are skipped: model codes
//    (F34246, IM21-…), sizes, and Japanese titles stay out of scope
//  - edit distance thresholds scale with alias length (1 for short aliases,
//    up to 3 for long ones) so "capitol" can never become "kapital"
//  - aliases under 6 chars stay exact-only: at that length a distance-1 edit
//    collides with ordinary words ("Ebisu" the place, "Yebisu" the beer —
//    both distance-1 from evisu; both false-positive in the live DB)
//  - space/punctuation-stripped comparison catches concatenated brand names
//    ("yohjiyamamoto", "issey miyake") — a very common listing style on JP
//    markets
//  - the curated homonym guards (negativeJpAliases) still apply afterwards
// ---------------------------------------------------------------------------

/** NFD accent folding: garçons -> garcons, é -> e, etc. */
function foldAscii(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

const FUZZY_WORD = /^[a-z][a-z'’-]+$/;
const FUZZY_MIN_ALIAS = 5;

function fuzzyThreshold(aliasLen: number): number {
  if (aliasLen <= 7) return 1;
  if (aliasLen <= 11) return 2;
  return 3;
}

/** Damerau-Levenshtein distance, bailing out once the result must exceed `max`. */
export function boundedDamerau(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return Math.max(m, n) <= max ? Math.max(m, n) : max + 1;
  let prevPrev: number[] | null = null;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev![j - 2]! + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // whole row already too far — bail
    prevPrev = prev;
    prev = cur;
  }
  return prev[n]! <= max ? prev[n]! : max + 1;
}

function matchBrandFuzzy(t: string): { brandKey: string; matched: string } | undefined {
  // Keep ALL ascii-letter words (even short ones like "des"/"for") —
  // dropping them would destroy multi-word windows ("comme des garcuns").
  // Short windows simply never match, because every fuzzy-compared alias
  // is >= FUZZY_MIN_ALIAS chars.
  const words = foldAscii(t)
    .split(/\s+/)
    .filter((w) => FUZZY_WORD.test(w));
  if (words.length === 0) return undefined;

  // Candidate windows: 1-3 consecutive words (all curated aliases of
  // interest are <= 3 words; longer phrases are distinctive enough that
  // the exact pass already catches them).
  const windows: string[] = [];
  for (let i = 0; i < words.length; i++) {
    windows.push(words[i]!);
    if (i + 1 < words.length) windows.push(`${words[i]} ${words[i + 1]}`);
    if (i + 2 < words.length) windows.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  }

  // Best fuzzy candidate per window; a window matching two DIFFERENT brands
  // at the same distance is ambiguous and discarded entirely.
  const perWindow = new Map<string, { brandKey: string; dist: number; aliasLen: number } | "ambiguous">();
  for (const entry of ALIAS_INDEX) {
    if (entry.isJp) continue; // romaji/EN aliases only for fuzzy
    if (entry.alias.length < FUZZY_MIN_ALIAS) continue;
    const max = fuzzyThreshold(entry.alias.length);
    const compactAlias = entry.alias.replace(/['’ -]/g, "");
    for (const win of windows) {
      // Single-word fuzzy hits need aliases >= 6 chars: shorter aliases
      // (evisu, marni, sacai…) collide with ordinary words at distance 1.
      const isSingle = !win.includes(" ");
      if (isSingle && entry.alias.length < 6) continue;
      if (Math.abs(win.length - entry.alias.length) > max) continue;
      let d = boundedDamerau(win, entry.alias, max);
      if (isSingle) {
        d = Math.min(d, boundedDamerau(win.replace(/['’-]/g, ""), compactAlias, max));
      }
      if (d > max) continue;
      const prev = perWindow.get(win);
      if (!prev) {
        perWindow.set(win, { brandKey: entry.brandKey, dist: d, aliasLen: entry.alias.length });
      } else if (prev !== "ambiguous") {
        if (d < prev.dist || (d === prev.dist && entry.alias.length > prev.aliasLen)) {
          perWindow.set(win, { brandKey: entry.brandKey, dist: d, aliasLen: entry.alias.length });
        } else if (d === prev.dist && entry.brandKey !== prev.brandKey) {
          perWindow.set(win, "ambiguous");
        }
      }
    }
  }

  let best: { brandKey: string; matched: string; dist: number; aliasLen: number } | undefined;
  for (const [win, hit] of perWindow) {
    if (hit === "ambiguous") continue;
    if (!best || hit.dist < best.dist || (hit.dist === best.dist && hit.aliasLen > best.aliasLen)) {
      best = { brandKey: hit.brandKey, matched: win, dist: hit.dist, aliasLen: hit.aliasLen };
    }
  }
  if (!best) return undefined;

  // Homonym guard applies to fuzzy hits too ("suprme fishing reel").
  const brand = BRAND_BY_KEY.get(best.brandKey);
  if (brand?.negativeJpAliases?.some((n) => t.includes(n.toLowerCase()))) return undefined;
  return { brandKey: best.brandKey, matched: best.matched };
}

export function getBrand(key: string): Brand | undefined {
  return BRAND_BY_KEY.get(key);
}
