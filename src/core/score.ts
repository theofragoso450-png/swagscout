import type { Deal, DealReason, Listing } from "../types.js";
import { evaluateThreshold } from "../config/rules.js";
import { extractCondition } from "./normalize.js";
import { findComps, DEFAULT_COMP_OPTIONS, type CompOptions } from "./comps.js";
import type { StoredListing, Store } from "./store.js";
import { proxyLinks } from "../proxy/links.js";
import { fxRatesSnapshot, round2, usdFrom } from "./fx.js";

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

  // One rate set for the whole evaluation. The candidate's priceUsd was baked in
  // at ingest; re-deriving it here from the native price and pinning the same
  // set for the band filter and every comp means a refresh landing mid-decision
  // cannot compare today's yen against yesterday's dollar.
  const rates = fxRatesSnapshot();
  let candidateUsd = l.priceUsd;
  try {
    candidateUsd = round2(usdFrom(l.price, l.currency, rates));
  } catch {
    /* currency we cannot convert — keep the value ingest recorded */
  }
  const candidate: Listing = { ...l, priceUsd: candidateUsd };

  // 1) Static threshold rule. Condition is derived from the title the
  // evaluation actually sees — the stored column is only a display cache and
  // can be stale relative to a replaced/spread title. Deriving keeps
  // condition-aware caps honest without a column migration.
  const threshold = evaluateThreshold({
    brandKey: candidate.brandKey,
    title: candidate.title,
    priceUsd: candidateUsd,
    condition: extractCondition(candidate.title),
  });
  if (threshold) {
    reasons.push({ kind: "threshold", capUsd: threshold.maxUsd, note: threshold.note });
  }

  // 2) Cross-market comps (phase-2 engine, same codebase)
  let comp: Deal["comp"] | undefined;
  if (candidate.brandKey) {
    const roundUsd = ctx.compRoundUsd;
    const rounded = Math.round(candidateUsd / roundUsd) * roundUsd;
    const band = ctx.store.recentByBrandRounded(
      candidate.brandKey,
      roundUsd,
      rounded,
      14 * 24,
      rates,
    );
    const compMatch = findComps(
      candidate,
      band,
      ctx.compOptions ?? DEFAULT_COMP_OPTIONS,
      ctx.compsExcludeSameMarket ?? false,
    );
    if (compMatch && compMatch.discountPct >= (ctx.compOptions ?? DEFAULT_COMP_OPTIONS).triggerDiscountPct) {
      compMatch.roundUsd = roundUsd;
      // Store the median natively (in the candidate's own currency), converted
      // at the pinned rate. A USD median frozen here would drift against the
      // card's re-derived price the moment the rate moved, eventually pushing the
      // candidate above its own median and inverting the sentence.
      const currency = candidate.currency;
      const currencyRate = rates[currency] ?? 0;
      reasons.push(
        currencyRate > 0
          ? {
              kind: "comp",
              medianPrice: round2(compMatch.medianUsd / currencyRate),
              medianCurrency: currency,
              sampleSize: compMatch.sampleSize,
            }
          : { kind: "comp", medianUsd: compMatch.medianUsd, sampleSize: compMatch.sampleSize },
      );
      comp = compMatch;
    }
  }

  if (reasons.length === 0) return undefined;

  const score = scoreDeal(candidate, reasons, comp);
  return { listing: candidate, proxy: proxyLinks(candidate), reasons, score, comp };
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
