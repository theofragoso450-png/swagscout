import { matchBrand } from "../config/brands.js";
import { extractSize } from "./normalize.js";
import { evaluateDeal } from "./score.js";
import type { Listing, MarketId } from "../types.js";
import type { Store, StoredListing } from "./store.js";
import { PIPELINE_VERSION } from "./pipeline.js";
import { logger } from "../logger.js";

/** Max stale rows evaluated per boot pass; the rest wait for a later boot. */
const MAX_ROWS = 5000;
/** Reasonable time budget for the catch-up pass (ms). */
const BUDGET_MS = 10_000;

export interface RecomputeStats {
  scanned: number;
  brandFills: number;
  brandUpgrades: number;
  brandUnbranded: number;
  sizeFollows: number;
  dealsCreated: number;
  dealsUpdated: number;
  dealsDropped: number;
  remaining: number;
}

/**
 * Bring every listing older than the current pipeline version up to date.
 *
 * Policy (learned from the two manual backfills in this codebase's history):
 *  - brand: null → brand is always applied ("fill"); brand → different brand
 *    is applied as an upgrade (the old label came from older code); a brand
 *    is NEVER stripped — a title that matched yesterday keeps its label
 *    today, even if guards would now refuse it (a Kapital coat matched
 *    before the CAPITAL guard must not lose its brand).
 *  - size: the current extractor's verdict wins, EXCEPT Grailed rows — its
 *    adapter passes explicit sizes at ingest, so extraction is not the
 *    source of truth there.
 *  - deals: rebuilt via delete + fresh evaluateDeal so reasons/scores route
 *    through the current rules engine; dealsDropped counts re-evaluations
 *    that no longer produce a deal.
 *
 * Everything runs in one store transaction (one writer, WAL); the version
 * stamps written inside it make the pass idempotent across restarts.
 */
export function recomputeStale(
  store: Store,
  ctx: { compRoundUsd: number },
): RecomputeStats {
  const stats: RecomputeStats = {
    scanned: 0,
    brandFills: 0,
    brandUpgrades: 0,
    brandUnbranded: 0,
    sizeFollows: 0,
    dealsCreated: 0,
    dealsUpdated: 0,
    dealsDropped: 0,
    remaining: 0,
  };

  const stale = store.staleListings(MAX_ROWS);
  if (stale.length === 0) {
    return stats;
  }
  stats.remaining = Math.max(0, store.countStale() - stale.length);

  const started = Date.now();

  store.transaction(() => {
    for (const row of stale) {
      if (stats.scanned > 0 && Date.now() - started > BUDGET_MS) {
        stats.remaining += stale.length - stats.scanned;
        break;
      }
      stats.scanned++;
      const policy = applyBrandPolicy(row);
      if (policy.kind === "fill") stats.brandFills++;
      else if (policy.kind === "upgrade") stats.brandUpgrades++;
      else if (policy.kind === "kept") stats.brandUnbranded++;
      const brand = policy.brand;
      const size = (row.market === "grailed" ? row.size : extractSize(row.title)) ?? null;
      if (size !== row.size) stats.sizeFollows++;
      store.updateDerivedValues(row.key, brand, size);

      const fresh = evaluateDeal(toListing(row, brand, size), {
        store,
        compRoundUsd: ctx.compRoundUsd,
      });
      const had = store.dealExistsFor(row.key);
      if (fresh && had) {
        store.deleteDealsFor(row.key);
        store.recordDeal(fresh);
        stats.dealsUpdated++;
      } else if (fresh && !had) {
        store.recordDeal(fresh);
        stats.dealsCreated++;
      } else if (!fresh && had) {
        store.deleteDealsFor(row.key);
        stats.dealsDropped++;
      }
    }
  });

  logger.info({ pipelineVersion: PIPELINE_VERSION, ...stats }, "pipeline recompute complete");
  return stats;
}

/**
 * Brand policy: fill (null → brand), upgrade (old label from older code),
 * never strip. Returns the new brand plus which policy branch fired.
 */
function applyBrandPolicy(row: StoredListing): {
  brand: string | null;
  kind: "fill" | "upgrade" | "kept" | "same";
} {
  const computed = matchBrand(row.title);
  if (computed && !row.brandKey) return { brand: computed.brandKey, kind: "fill" };
  if (computed && row.brandKey && computed.brandKey !== row.brandKey) {
    return { brand: computed.brandKey, kind: "upgrade" };
  }
  if (!computed && row.brandKey) {
    // Keep the label (never un-brand) — a title that matched yesterday keeps
    // its brand today even if guards would now refuse it.
    return { brand: row.brandKey, kind: "kept" };
  }
  return { brand: row.brandKey, kind: "same" }; // agree, or both null
}

function toListing(row: StoredListing, brand: string | null, size: string | null): Listing {
  return {
    id: row.marketId,
    market: row.market as MarketId,
    title: row.title,
    brandKey: brand ?? undefined,
    price: row.price,
    currency: row.currency as Listing["currency"],
    priceUsd: row.priceUsd,
    url: row.url,
    foundAt: row.foundAt,
    size: size ?? undefined,
  };
}
