import type { Store } from "./store.js";
import { logger } from "../logger.js";

/**
 * Nightly retention: listings untouched for RETENTION_DAYS (default 30) are
 * pruned along with their deals, and the WAL is checkpointed. The window must
 * stay comfortably above the comp engine's 14-day lookback — 30 by default.
 *
 * Scheduling: an hourly tick with boot catch-up, deduped per UTC calendar day
 * in the store's meta table, so restarts never double-prune and a server that
 * boots mid-day catches up immediately. `RETENTION_DAYS=0` disables entirely.
 */

export interface RetentionOptions {
  /** Listings older than this many days (by updatedAt) are pruned. 0 = off. */
  days: number;
}

const DAY_MS = 86_400_000;

/** UTC calendar day of `t` — the dedupe key. */
export function utcDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Meta key holding the last day a prune ran. */
export function retentionKey(day: string): string {
  return `retention:${day}`;
}

/**
 * Should a prune run now? True when no prune has been recorded for the
 * current UTC day — including the very first boot after this feature lands.
 */
export function retentionDue(store: Store, now: number): boolean {
  return store.getMeta(retentionKey(utcDay(now))) === undefined;
}

export interface PruneResult {
  listingsDeleted: number;
  /** 0 when disabled, not due, or nothing old enough to remove. */
  dealsDeleted: number;
}

/** Run one prune pass if due. Returns what was removed. */
export function retentionTick(store: Store, opts: RetentionOptions, now = Date.now()): PruneResult {
  if (opts.days <= 0) return { listingsDeleted: 0, dealsDeleted: 0 };
  if (!retentionDue(store, now)) return { listingsDeleted: 0, dealsDeleted: 0 };

  const cutoff = new Date(now - opts.days * DAY_MS).toISOString();
  const { listings, deals } = store.pruneBefore(cutoff);

  store.setMeta(retentionKey(utcDay(now)), "done");
  if (listings + deals > 0) store.walCheckpoint();

  logger.info({ days: opts.days, cutoff, listings, deals }, "retention prune complete");
  return { listingsDeleted: listings, dealsDeleted: deals };
}

/** Hourly scheduler with boot catch-up. Returns a stop function. */
export function startRetention(store: Store, opts: RetentionOptions): () => void {
  const run = () => {
    try {
      retentionTick(store, opts);
    } catch (err) {
      logger.error({ err }, "retention prune failed — will retry next tick");
    }
  };
  run(); // catch-up: a boot mid-day still prunes that day
  const timer = setInterval(run, 3_600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
