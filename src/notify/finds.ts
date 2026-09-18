import type { Deal } from "../types.js";

/**
 * "Finds of the day" ranking — surfaces the most notable comp-backed deals,
 * judged by rarity (how far below the comp median, and how trustworthy that
 * median is) and price significance (a 50% cut on a $2000 coat matters more
 * than one on a $60 shirt). Pure so it is unit-testable.
 *
 * Only comp-backed deals rank: threshold deals all sit at the floor score and
 * would produce an arbitrary tie-break order rather than a meaningful ranking.
 */

export type Rarity = "S" | "A" | "B" | "C";

export interface FindRank {
  deal: Deal;
  rank: number;
  findsScore: number;
  rarity: Rarity;
}

export interface CompInfo {
  discountPct: number;
  sampleSize: number;
  medianUsd: number;
}

/** Pull the structured comp numbers back out of the stored reason text. */
export function parseCompReason(reasons: Deal["reasons"]): CompInfo | null {
  for (const r of reasons) {
    const m = /(\d+(?:\.\d+)?)% below (\d+)-listing median \(\$(\d+(?:\.\d+)?)\)/.exec(r.detail);
    if (m) {
      return { discountPct: Number(m[1]), sampleSize: Number(m[2]), medianUsd: Number(m[3]) };
    }
  }
  return null;
}

/** 0–30 by discount depth, 0–10 by comp-sample confidence, 0–20 by price class. */
export function findsScore(deal: Deal): number {
  const comp = parseCompReason(deal.reasons);
  if (!comp) return 0;
  const rarityPts = Math.min(30, Math.round(comp.discountPct * 0.6));
  const samplePts = Math.min(10, Math.round(Math.log2(comp.sampleSize) * 2));
  const pricePts = Math.min(20, Math.round(Math.log10(Math.max(10, comp.medianUsd)) * 5));
  return rarityPts + samplePts + pricePts;
}

export function classifyRarity(score: number): Rarity {
  if (score >= 55) return "S";
  if (score >= 40) return "A";
  if (score >= 25) return "B";
  return "C";
}

/**
 * Pool sizing for the finds surfaces: fetch exactly the documented window
 * (default 24h) rather than a newest-N guess. At high ingest a fixed
 * newest-N pool silently truncates the window — measured on this codebase's
 * own data, 500 rows spanned only ~7h.
 */
export function findsPool(nowMs: number, windowHours = 24): { since: string; limit: number } {
  const since = new Date(nowMs - windowHours * 3_600_000).toISOString();
  return { since, limit: 2000 };
}

/** Rank the day's comp-backed finds. Ties break to the earliest find. */
export function rankFinds(
  deals: Deal[],
  windowHours = 24,
  now = Date.now(),
  limit = 10,
): FindRank[] {
  const cutoff = now - windowHours * 3_600_000;
  return deals
    .filter((d) => {
      const t = Date.parse(d.listing.foundAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .map((d) => ({ deal: d, findsScore: findsScore(d) }))
    .filter((x) => x.findsScore > 0)
    .sort(
      (a, b) =>
        b.findsScore - a.findsScore ||
        a.deal.listing.foundAt.localeCompare(b.deal.listing.foundAt),
    )
    .slice(0, limit)
    .map((x, i) => ({ ...x, rank: i + 1, rarity: classifyRarity(x.findsScore) }));
}
