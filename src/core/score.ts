import type { Deal, DealReason, Listing } from "../types.js";
import { evaluateThreshold } from "../config/rules.js";
import { findComps, DEFAULT_COMP_OPTIONS, type CompOptions } from "./comps.js";
import type { StoredListing, Store } from "./store.js";
import { proxyLinks } from "../proxy/links.js";

export interface ScoreContext {
  store: Store;
  compRoundUsd: number;
  compOptions?: CompOptions;
  /** Skip same-market comps (JP-only deals vs JP comps). Default false. */
  compsExcludeSameMarket?: boolean;
}

/**
 * Evaluate a listing: threshold rule + cross-market comps → Deal (or null).
 * Returns undefined when neither engine fires. `extraReasons` (e.g. a
 * price_drop observed by the poller) are seeded before scoring so the deal's
 * score always reflects the reasons it carries.
 */
export function evaluateDeal(
  l: Listing,
  ctx: ScoreContext,
  extraReasons?: DealReason[],
): Deal | undefined {
  const reasons: DealReason[] = [...(extraReasons ?? [])];

  // 1) Static threshold rule
  const threshold = evaluateThreshold({
    brandKey: l.brandKey,
    title: l.title,
    priceUsd: l.priceUsd,
  });
  if (threshold) {
    reasons.push({ kind: "threshold", detail: threshold });
  }

  // 2) Cross-market comps (phase-2 engine, same codebase)
  let comp: Deal["comp"] | undefined;
  if (l.brandKey) {
    const roundUsd = ctx.compRoundUsd;
    const rounded = Math.round(l.priceUsd / roundUsd) * roundUsd;
    const band = ctx.store.recentByBrandRounded(l.brandKey, roundUsd, rounded, 14 * 24);
    const compMatch = findComps(
      l,
      band,
      ctx.compOptions ?? DEFAULT_COMP_OPTIONS,
      ctx.compsExcludeSameMarket ?? false,
    );
    if (compMatch && compMatch.discountPct >= (ctx.compOptions ?? DEFAULT_COMP_OPTIONS).triggerDiscountPct) {
      compMatch.roundUsd = roundUsd;
      reasons.push({
        kind: "comp",
        detail: `${compMatch.discountPct}% below ${compMatch.sampleSize}-listing median ($${compMatch.medianUsd.toFixed(0)})`,
      });
      comp = compMatch;
    }
  }

  if (reasons.length === 0) return undefined;

  const score = scoreDeal(l, reasons, comp);
  return { listing: l, proxy: proxyLinks(l), reasons, score, comp };
}

/**
 * Deal score: thresholds contribute by how far under the cap the price is;
 * comps contribute by discount depth; price drops add a small boost.
 */
export function scoreDeal(
  listing: Listing,
  reasons: DealReason[],
  comp?: CompMatchLike,
): number {
  let score = 0;
  for (const r of reasons) {
    if (r.kind === "threshold") score += 40;
    if (r.kind === "comp") score += Math.min(50, comp?.discountPct ?? 30);
    if (r.kind === "price_drop") score += 15;
  }
  // bonus for auctions about to end (urgency)
  if (listing.endsAt) {
    const hoursLeft = (Date.parse(listing.endsAt) - Date.now()) / 3_600_000;
    if (hoursLeft > 0 && hoursLeft < 6) score += 10;
  }
  return Math.round(score);
}

export interface CompMatchLike {
  discountPct: number;
}
