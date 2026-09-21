import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { catchUpPipeline, recomputeStale } from "../src/core/recompute.js";
import type { Listing } from "../src/types.js";

/**
 * The boot catch-up used to be one bounded pass per boot, so a PIPELINE_VERSION
 * bump only converged across ~11 restarts and every boot paid its budget before
 * the dashboard could bind. These pin the replacement: one call clears the whole
 * backlog, it computes exactly what the blocking pass computed, it yields to the
 * event loop rather than holding it, and it stays honest if the store goes away
 * underneath it.
 */

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "catchup-"));
  dbPath = path.join(dir, "test.db");
  store = new Store(dbPath);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

type RawDb = {
  prepare: (sql: string) => {
    all: (...args: unknown[]) => unknown[];
    run: (...args: unknown[]) => unknown;
  };
};

/** Raw columns off the store — the persisted truth, not a derived view. */
function rawDb(s: Store): RawDb {
  return (s as unknown as { db: RawDb }).db;
}

/**
 * `n` listings as an older pipeline left them: stale stamp, no derived brand or
 * size. Distinct foundAt per row so the catch-up's evaluation order (and with it
 * the store state each row is scored against) is deterministic.
 */
function seed(s: Store, n: number): void {
  const base = Date.now() - 3_600_000;
  for (let i = 0; i < n; i++) {
    const l: Listing = normalizeListing({
      market: "yahoo",
      id: `c${String(i).padStart(2, "0")}`,
      title: "COMME des GARCONS tee",
      price: 1000 + i * 10,
      currency: "JPY",
      url: `https://auctions.yahoo.co.jp/jp/auction/c${i}`,
    });
    l.foundAt = new Date(base + i * 1000).toISOString();
    s.upsertListing(l);
  }
  s.transaction(() => {
    rawDb(s).prepare("UPDATE listings SET pipelineVersion = 0, brandKey = NULL, size = NULL").run();
  });
}

function listingShape(s: Store): unknown[] {
  return rawDb(s)
    .prepare("SELECT key, brandKey, size, pipelineVersion FROM listings ORDER BY key")
    .all();
}

function dealShape(s: Store): unknown[] {
  return rawDb(s).prepare("SELECT listingKey, score, reasons FROM deals ORDER BY listingKey").all();
}

describe("boot-time pipeline catch-up", () => {
  it("clears a backlog larger than one chunk in a single call", async () => {
    seed(store, 12);
    expect(store.countStale()).toBe(12);

    // Chunk of 5 rows: the old single-pass limit would have left 7 for a restart.
    const stats = await catchUpPipeline(store, { compRoundUsd: 5 }, { maxRows: 5 });

    expect(stats.scanned).toBe(12);
    expect(stats.remaining).toBe(0);
    expect(store.countStale()).toBe(0);
  });

  it("recomputes every row exactly as one blocking pass does", async () => {
    const refDir = mkdtempSync(path.join(tmpdir(), "catchup-ref-"));
    const reference = new Store(path.join(refDir, "test.db"));
    try {
      seed(store, 12);
      seed(reference, 12);

      // The reference is the old shape: one pass, no ceiling.
      recomputeStale(reference, { compRoundUsd: 5 }, { maxRows: 1000, budgetMs: 60_000 });
      await catchUpPipeline(store, { compRoundUsd: 5 }, { maxRows: 3, budgetMs: 60_000 });

      // Same derived values, same deals, same scores, same reasons — chunking
      // changes when rows are written, never what is computed for them.
      expect(listingShape(store)).toEqual(listingShape(reference));
      expect(dealShape(store)).toEqual(dealShape(reference));
    } finally {
      reference.close();
      rmSync(refDir, { recursive: true, force: true });
    }
  });

  it("yields to the event loop between chunks instead of holding it", async () => {
    seed(store, 12);
    let yields = 0;
    const stats = await catchUpPipeline(
      store,
      { compRoundUsd: 5 },
      {
        maxRows: 4,
        yieldTo: async () => {
          yields++;
        },
      },
    );
    // 12 rows at 4 per chunk = 3 chunks, plus the yield before the first one.
    expect(stats.scanned).toBe(12);
    expect(yields).toBe(3);

    // And with the default yield the loop really does turn: a self-rescheduling
    // macrotask can only run between chunks.
    seed(store, 12);
    let turns = 0;
    let handle: NodeJS.Immediate | undefined;
    const spin = () => {
      turns++;
      handle = setImmediate(spin);
    };
    handle = setImmediate(spin);
    try {
      await catchUpPipeline(store, { compRoundUsd: 5 }, { maxRows: 2, budgetMs: 60_000 });
    } finally {
      if (handle) clearImmediate(handle);
    }
    expect(turns).toBeGreaterThan(1);
  });

  it("returns partial totals when the store closes mid-run", async () => {
    seed(store, 20);
    let yields = 0;
    const stats = await catchUpPipeline(
      store,
      { compRoundUsd: 5 },
      {
        maxRows: 2,
        budgetMs: 60_000,
        yieldTo: async () => {
          // Close under it after two committed chunks.
          if (++yields === 3) store.close();
        },
      },
    );

    expect(stats.scanned).toBe(4);
    expect(stats.remaining).toBeGreaterThan(0);
  });

  it("stops between chunks when the signal aborts, keeping what it stamped", async () => {
    seed(store, 12);
    const abort = new AbortController();
    let yields = 0;
    const stats = await catchUpPipeline(
      store,
      { compRoundUsd: 5 },
      {
        maxRows: 2,
        budgetMs: 60_000,
        signal: abort.signal,
        yieldTo: async () => {
          // Abort once two chunks have committed.
          if (++yields === 3) abort.abort();
        },
      },
    );

    // Two chunks landed, then the loop stopped: no chunk runs after an abort.
    expect(stats.scanned).toBe(4);
    expect(stats.remaining).toBe(8);
    // Committed, not half-applied — the unstamped rows are simply still stale,
    // which is what makes the next boot's catch-up resumable.
    expect(store.countStale()).toBe(8);
  });
});
