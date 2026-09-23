import type { Deal } from "../types.js";
import { compFacts } from "../core/reasons.js";

/**
 * "Finds of the day" ranking — surfaces the most notable comp-backed deals,
 * judged by rarity (how far below the comp median, and how trustworthy that
 * median is), price significance (a 50% cut on a $2000 coat matters more
 * than one on a $60 shirt), and sell-through (pieces from brands whose stock
 * tends to vanish are likelier to be gone soon — absence ≠ sale, so the
 * labels say "moves fast", never "sold"). Pure so it is unit-testable.
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

/** Per-brand gone-now aggregate from store.sellThroughByBrand(). */
export type VelocityMap = ReadonlyMap<string, { share: number }>;

/**
 * Gone-now share at or above which a find earns the "Fast mover" label on
 * surfaces that cannot show the score breakdown. Deliberately high: it must
 * mean "this brand's stock reliably vanishes", not "a few rows went missing".
 */
export const FAST_MOVER_SHARE = 0.5;

export interface FindsScoreContext {
  /** Brand-level sell-through; absent or missing brand = no velocity points. */
  velocity?: VelocityMap;
}

/** 0–30 by discount depth, 0–10 by comp-sample confidence, 0–20 by price class, 0–10 by sell-through. */
export function findsScore(deal: Deal, ctx: FindsScoreContext = {}): number {
  const comp = compFacts(deal.reasons, deal.listing.priceUsd);
  if (!comp) return 0;
  const rarityPts = Math.min(30, Math.round(comp.discountPct * 0.6));
  const samplePts = Math.min(10, Math.round(Math.log2(comp.sampleSize) * 2));
  const pricePts = Math.min(20, Math.round(Math.log10(Math.max(10, comp.medianUsd)) * 5));
  const velocityPts = velocityFactor(deal, ctx.velocity);
  return rarityPts + samplePts + pricePts + velocityPts;
}

/**
 * Sell-through points, 0–10: share² × 10 (share ∈ [0,1] by construction in
 * the store, so the range holds without a cap). The square keeps the boost a
 * tie-breaker among already-good finds rather than a multiplier that could
 * let a fast-moving brand outrank a deeper discount on real comp evidence;
 * shares below ~25% round to zero — ordinary attrition earns nothing. The
 * aggregate is brand-level stock churn — it never claims an individual piece
 * sold.
 */
function velocityFactor(deal: Deal, velocity: VelocityMap | undefined): number {
  if (!velocity) return 0;
  const brand = deal.listing.brandKey;
  if (!brand) return 0;
  const v = velocity.get(brand);
  if (!v) return 0;
  return Math.round(v.share * v.share * 10);
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

/**
 * Rank the day's comp-backed finds. Ties break to the earliest find. The
 * finds score never depends on currency data — velocity comes from
 * `missingSince` booleans, so an FX rate move cannot reorder the list.
 */
export function rankFinds(
  deals: Deal[],
  windowHours = 24,
  now = Date.now(),
  limit = 10,
  ctx: FindsScoreContext = {},
): FindRank[] {
  const cutoff = now - windowHours * 3_600_000;
  return deals
    .filter((d) => {
      const t = Date.parse(d.listing.foundAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .map((d) => ({ deal: d, findsScore: findsScore(d, ctx) }))
    .filter((x) => x.findsScore > 0)
    .sort(
      (a, b) =>
        b.findsScore - a.findsScore ||
        a.deal.listing.foundAt.localeCompare(b.deal.listing.foundAt),
    )
    .slice(0, limit)
    .map((x, i) => ({ ...x, rank: i + 1, rarity: classifyRarity(x.findsScore) }));
}
