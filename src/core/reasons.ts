import { round2, toUsd } from "./fx.js";
import { formatUsd } from "./money.js";
import type { DealReason } from "../types.js";

/**
 * Rendering for deal reasons — the one place a reason becomes a sentence.
 *
 * The price is an argument, never a stored string: `priceUsd` is re-derived at
 * read time from the listing's native price and currency, so a reason that
 * baked in its own ingest-time price printed a different number than the card
 * next to it. Every surface (dashboard, Discord, finds) renders through here
 * with the price it is showing, which is what makes the two agree by
 * construction rather than by luck.
 *
 * A reason carrying no parameters has only its recorded `detail` — deals stored
 * before reasons were structured, and callers that supply prose directly.
 * Nothing can be re-rendered for those, so the text stands as recorded.
 *
 * A comp median and a drop's from-price are stored NATIVE and converted here at
 * the rate in force — the same rate the card's price is derived at — so the two
 * sides of the comparison share a vintage and an FX move can never invert the
 * sentence. Reasons stored before native amounts fall back to their USD figure.
 *
 * Money is written by `formatUsd` (core/money.ts), the one policy every surface
 * shares, so the number a reason names is the number printed beside it.
 */
export function formatReason(r: DealReason, priceUsd: number): string {
  if (r.kind === "threshold" && r.capUsd !== undefined) {
    const note = r.note ? ` — ${r.note}` : "";
    return `price ${formatUsd(priceUsd)} ≤ ${formatUsd(r.capUsd)}${note}`;
  }
  if (r.kind === "comp") {
    const medianUsd = nativeUsd(r.medianPrice, r.medianCurrency) ?? r.medianUsd;
    if (medianUsd !== undefined && r.sampleSize !== undefined) {
      const pct = compDiscountPct(priceUsd, medianUsd);
      return `${pct}% below ${r.sampleSize}-listing median (${formatUsd(medianUsd)})`;
    }
  }
  if (r.kind === "price_drop") {
    const was = nativeUsd(r.wasPrice, r.wasCurrency) ?? recordedWasUsd(r);
    if (was !== undefined) return `dropped from ${formatUsd(was)} to ${formatUsd(priceUsd)}`;
  }
  return r.detail ?? "";
}

/**
 * A stored reference converted to USD at the rate in force — the same rate the
 * price it is compared against was derived at. Falls back to undefined (so the
 * caller uses the recorded USD) when there is no native amount or the currency
 * cannot be converted.
 */
function nativeUsd(native: number | undefined, currency: string | undefined): number | undefined {
  if (native === undefined || currency === undefined) return undefined;
  try {
    return round2(toUsd(native, currency));
  } catch {
    return undefined;
  }
}

/**
 * The USD from-price a reason records before any native conversion: the stored
 * `wasUsd`, or the figure written into a drop line from before reasons carried
 * their numbers. Shared with the rebuild, which converts it to a native amount.
 */
export function recordedWasUsd(r: DealReason): number | undefined {
  return r.wasUsd ?? legacyWasUsd(r.detail);
}

/** The from-price recorded in a drop line written before reasons carried their
 *  numbers. Worth recovering rather than replaying: those rows recorded their
 *  own "to" price, which has since drifted (and a few recorded a nonsense one). */
function legacyWasUsd(detail: string | undefined): number | undefined {
  const m = LEGACY_DROP.exec(detail ?? "");
  if (!m) return undefined;
  const was = Number(m[1]);
  return Number.isFinite(was) && was > 0 ? was : undefined;
}

/** How far under a median a price sits, at the precision comps.ts records. */
function compDiscountPct(priceUsd: number, medianUsd: number): number {
  return Math.round(((medianUsd - priceUsd) / medianUsd) * 1000) / 10;
}

/** The comp numbers behind a deal, at the price in hand. */
interface CompFacts {
  discountPct: number;
  sampleSize: number;
  medianUsd: number;
}

/** Reason text as written before reasons carried their numbers. */
const LEGACY_COMP = /(\d+(?:\.\d+)?)% below (\d+)-listing median \(\$(\d+(?:\.\d+)?)\)/;
const LEGACY_DROP = /dropped from \$(\d+(?:\.\d+)?)/;

/**
 * The comp facts a deal's reasons hold, with the discount re-derived against
 * `priceUsd` so a ranking and a card agree about today's discount. A native
 * median is converted at the rate in force, same as the card's price. Falls back
 * to the recorded text when a reason has no parameters, which is how deals
 * stored before this change still score.
 */
export function compFacts(reasons: readonly DealReason[], priceUsd: number): CompFacts | null {
  for (const r of reasons) {
    if (r.kind !== "comp") continue;
    const medianUsd = nativeUsd(r.medianPrice, r.medianCurrency) ?? r.medianUsd;
    if (medianUsd !== undefined && r.sampleSize !== undefined) {
      return {
        discountPct: compDiscountPct(priceUsd, medianUsd),
        sampleSize: r.sampleSize,
        medianUsd,
      };
    }
    const m = LEGACY_COMP.exec(r.detail ?? "");
    if (m) {
      return { discountPct: Number(m[1]), sampleSize: Number(m[2]), medianUsd: Number(m[3]) };
    }
  }
  return null;
}
