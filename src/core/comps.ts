import type { Listing, MarketId, CompMatch, CompSnapshot } from "../types.js";
import type { StoredListing } from "./store.js";

/**
 * Cross-market comp engine.
 *
 * For a candidate listing we compare against recent listings of the same
 * brand within a rounded-price band. Items are fuzzy-matched on title-token
 * overlap (Jaccard on token sets + trigram similarity). The median price of
 * good matches defines the comp price; a candidate is "underpriced" when it
 * sits a configurable % below that median.
 */

export interface CompOptions {
  /** Tokens required to match (brand slug enforced upstream). */
  minTokenOverlap: number;
  /** Minimum similarity for two titles to be considered the same item. */
  minSimilarity: number;
  /** Minimum number of good comps required to trust the median. */
  minSample: number;
  /** % below median to trigger a comp deal. */
  triggerDiscountPct: number;
}

export const DEFAULT_COMP_OPTIONS: CompOptions = {
  minTokenOverlap: 2,
  minSimilarity: 0.55,
  minSample: 3,
  triggerDiscountPct: 35,
};

function tokenize(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9ぁ-んァ-ヶー一-龠\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function trigrams(s: string): Set<string> {
  const norm = ` ${s.toLowerCase().replace(/\s+/g, " ").trim()} `;
  const set = new Set<string>();
  for (let i = 0; i < norm.length - 2; i++) set.add(norm.slice(i, i + 3));
  return set;
}

function similarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size); // Dice coefficient on trigrams
}

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function toSnapshot(s: StoredListing): CompSnapshot {
  return { market: s.market as MarketId, priceUsd: s.priceUsd, url: s.url };
}

/**
 * Find comps for a candidate listing among stored recent listings of the
 * same brand + price band. Excludes listings from the same market listing id
 * (self) and — optionally — the candidate's own market entirely.
 */
export function findComps(
  candidate: Listing,
  candidates: StoredListing[],
  opts: CompOptions = DEFAULT_COMP_OPTIONS,
  excludeSameMarket = false,
): CompMatch | undefined {
  const candTokens = tokenize(candidate.title);
  const matches: CompSnapshot[] = [];

  for (const row of candidates) {
    if (row.market === candidate.market && row.marketId === candidate.id) continue;
    if (excludeSameMarket && row.market === candidate.market) continue;

    const overlap = [...candTokens].filter((t) => tokenize(row.title).has(t)).length;
    if (overlap < opts.minTokenOverlap) continue;

    const sim = similarity(candidate.title, row.title);
    if (sim < opts.minSimilarity) continue;

    matches.push(toSnapshot(row));
  }

  if (matches.length < opts.minSample) return undefined;

  const prices = matches.map((m) => m.priceUsd);
  const medianUsd = median(prices);
  if (medianUsd <= 0) return undefined;

  const discountPct = ((medianUsd - candidate.priceUsd) / medianUsd) * 100;

  return {
    roundUsd: 0, // set by caller
    medianUsd: Math.round(medianUsd * 100) / 100,
    sampleSize: matches.length,
    samples: matches.slice(0, 6),
    discountPct: Math.round(discountPct * 10) / 10,
  };
}
