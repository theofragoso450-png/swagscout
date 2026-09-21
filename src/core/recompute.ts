import { matchBrand } from "../config/brands.js";
import { extractSize } from "./normalize.js";
import { evaluateDeal } from "./score.js";
import { sleep } from "./http.js";
import type { DealReason, Listing, MarketId } from "../types.js";
import type { Store, StoredListing } from "./store.js";
import { PIPELINE_VERSION } from "./pipeline.js";
import { logger } from "../logger.js";

/** Max stale rows evaluated per pass; anything beyond waits for the next pass. */
const MAX_ROWS = 5000;
/** Reasonable time budget for one pass (ms). */
const BUDGET_MS = 10_000;

/**
 * One chunk of the background catch-up. Chunks stay small on purpose: a chunk
 * runs synchronously (node:sqlite is), so its budget is the longest a poll tick
 * or a dashboard request can be held off. 250ms is under what anyone notices,
 * and still amortizes each chunk's transaction over a few dozen rows.
 */
const CHUNK_ROWS = 400;
const CHUNK_MS = 250;
/** How often a long catch-up reports progress instead of going quiet. */
const PROGRESS_LOG_MS = 10_000;

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
 * stamps written inside it make the pass idempotent across restarts, which is
 * what lets `catchUpPipeline` drive this repeatedly in a single boot.
 *
 * This is ONE bounded pass; `limits` exists for that driver. Its defaults are
 * the historical single-pass size.
 */
export interface RecomputeLimits {
  /** Rows to evaluate in this pass. */
  maxRows?: number;
  /** Wall-clock budget for this pass; a pass stops early once it is spent. */
  budgetMs?: number;
}

export function recomputeStale(
  store: Store,
  ctx: { compRoundUsd: number },
  limits: RecomputeLimits = {},
): RecomputeStats {
  const maxRows = limits.maxRows ?? MAX_ROWS;
  const budgetMs = limits.budgetMs ?? BUDGET_MS;
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

  const stale = store.staleListings(maxRows);
  if (stale.length === 0) {
    return stats;
  }
  stats.remaining = Math.max(0, store.countStale() - stale.length);

  const started = Date.now();

  store.transaction(() => {
    for (const row of stale) {
      if (stats.scanned > 0 && Date.now() - started > budgetMs) {
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

      const prior = store.dealReasonsFor(row.key);
      const fresh = evaluateDeal(
        toListing(row, brand, size),
        { store, compRoundUsd: ctx.compRoundUsd },
        carried(prior),
      );
      const had = store.dealExistsFor(row.key);
      if (fresh && had) {
        store.replaceDeal(fresh);
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

  return stats;
}

export interface CatchUpOptions extends RecomputeLimits {
  /** Event-loop yield between chunks; injected by tests. */
  yieldTo?: () => Promise<void>;
  /**
   * Stop between chunks. What was stamped stays committed; the rest is simply
   * still stale, so an aborted catch-up resumes exactly where it left off. This
   * is how a shutdown ends the loop instead of closing the store under it.
   */
  signal?: AbortSignal;
}

/**
 * Work the whole stale backlog in one boot.
 *
 * A version bump used to converge across ~11 restarts: one bounded pass per
 * boot, each paying its budget before the dashboard could bind. This drives the
 * same pass repeatedly, yielding to the event loop between chunks, so the
 * backlog clears in a single boot, the servers keep answering throughout, and
 * every row is recomputed by exactly the code above — only the scheduling
 * differs, never the scoring.
 *
 * Termination: each pass stamps what it scans, and rows ingested during the
 * catch-up already carry the current version, so the stale set only shrinks. A
 * pass that scans nothing while rows remain would spin forever, so it stops and
 * leaves them to the next boot. If the store closes underneath us (a shutdown
 * mid-run) the partial totals are returned: what was stamped is committed, and
 * the rest is still stale.
 */
export async function catchUpPipeline(
  store: Store,
  ctx: { compRoundUsd: number },
  opts: CatchUpOptions = {},
): Promise<RecomputeStats> {
  const limits: RecomputeLimits = {
    maxRows: opts.maxRows ?? CHUNK_ROWS,
    budgetMs: opts.budgetMs ?? CHUNK_MS,
  };
  const yieldTo = opts.yieldTo ?? (() => sleep(0));
  const totals: RecomputeStats = {
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
  const started = Date.now();
  let passes = 0;
  let lastProgressLog = started;

  // Yield first: the caller is the boot path, and nothing here may hold it up.
  await yieldTo();

  // A chunk is synchronous, so the signal is observed only between them: one
  // chunk's worth of work is the longest a stop can take.
  const stopped = () => opts.signal?.aborted === true;
  while (!stopped()) {
    let chunk: RecomputeStats;
    try {
      chunk = recomputeStale(store, ctx, limits);
    } catch (err) {
      logger.warn(
        { err, scanned: totals.scanned, remaining: totals.remaining },
        "pipeline catch-up stopped early — stale rows wait for the next boot",
      );
      return totals;
    }
    passes++;
    totals.scanned += chunk.scanned;
    totals.brandFills += chunk.brandFills;
    totals.brandUpgrades += chunk.brandUpgrades;
    totals.brandUnbranded += chunk.brandUnbranded;
    totals.sizeFollows += chunk.sizeFollows;
    totals.dealsCreated += chunk.dealsCreated;
    totals.dealsUpdated += chunk.dealsUpdated;
    totals.dealsDropped += chunk.dealsDropped;
    totals.remaining = chunk.remaining;

    if (chunk.remaining === 0) break;
    if (chunk.scanned === 0) {
      logger.warn(
        { remaining: chunk.remaining },
        "pipeline catch-up made no progress — stopping until the next boot",
      );
      break;
    }
    if (Date.now() - lastProgressLog > PROGRESS_LOG_MS) {
      lastProgressLog = Date.now();
      logger.info(
        { scanned: totals.scanned, remaining: chunk.remaining },
        "pipeline catch-up progress",
      );
    }
    await yieldTo();
  }

  // A stop that beat the first chunk leaves nothing recorded, so read the
  // backlog here: the caller is owed how much is still waiting, not an all-zero
  // "nothing stale" that is a lie. Deliberately not done up front — that would
  // put a synchronous table scan on the boot path this driver exists to spare,
  // and it scales with the store rather than with the work done.
  if (passes === 0) {
    try {
      totals.remaining = store.countStale();
    } catch {
      // Store already closed: the empty sample is all this run can report.
    }
  }

  const ms = Date.now() - started;
  if (stopped() && totals.remaining > 0) {
    logger.info(
      { pipelineVersion: PIPELINE_VERSION, passes, ms, ...totals },
      "pipeline catch-up stopped — the rest resumes on the next boot",
    );
    return totals;
  }
  // Silent when there was nothing stale: a healthy boot adds no log line.
  if (totals.scanned > 0) {
    logger.info(
      { pipelineVersion: PIPELINE_VERSION, passes, ms, ...totals },
      "pipeline catch-up complete",
    );
  }
  return totals;
}

/**
 * Reasons a rebuild must carry forward. Everything else in a deal is derived
 * from the listing and the catalog, but a price drop records an event that was
 * only ever observed once — dropping it would delete information the pass
 * cannot recreate (and with it the deal's drop score).
 */
function carried(prior: DealReason[]): DealReason[] {
  return prior.filter((r) => r.kind === "price_drop");
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
