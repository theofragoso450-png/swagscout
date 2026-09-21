import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { recomputeStale } from "../src/core/recompute.js";
import { formatReason } from "../src/core/reasons.js";
import * as fx from "../src/core/fx.js";
import type { DealReason, Listing } from "../src/types.js";

/**
 * A drop's from-price and a comp's median are stored NATIVE and converted at
 * render time, at the same rate the card's own price is derived at. Stored as
 * frozen USD instead, the two sides of the comparison sit on different FX
 * vintages and a rate move turns a real drop into "from $10 to $11" and a real
 * discount into a negative percentage.
 *
 * This is the whole-store sweep of that invariant, kept as a test: it seeds
 * every reason shape a store can hold — native, structured-USD, and prose-only
 * legacy — rebuilds them through the real boot catch-up, then renders the whole
 * store at several simulated rates and fails if any line inverts. The key is
 * re-reading the deals at each vintage, exactly as the server does, so the
 * price and the reference it is compared against share one rate.
 */

const DROP = /^dropped from \$([\d.]+) to \$([\d.]+)$/;
const COMP = /^(-?[\d.]+)% below \d+-listing median \(\$[\d.]+\)$/;

/** Old price of the drop fixtures, in the currency they were recorded in. */
const WAS_USD = 77.42;

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fx-invariance-"));
  store = new Store(path.join(dir, "test.db"));
  fx.resetFxRates();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  fx.resetFxRates();
});

function jpy(id: string, title: string, price: number): Listing {
  return normalizeListing({
    market: "yahoo",
    id,
    title,
    price,
    currency: "JPY",
    url: `https://example.com/${id}`,
  });
}

/** Drive the store's stale rows to the current pipeline version, as boot does. */
function rebuild(): void {
  store.transaction(() => {
    (store as unknown as { db: { prepare: (s: string) => { run: () => void } } }).db
      .prepare("UPDATE listings SET pipelineVersion = 0")
      .run();
  });
  recomputeStale(store, { compRoundUsd: 50 });
}

/** Every reason line in the store, rendered at the rate in force right now. */
function renderAllReasons(): { drops: string[]; comps: string[] } {
  const drops: string[] = [];
  const comps: string[] = [];
  for (const deal of store.recentDeals(["all"], 1000)) {
    for (const reason of deal.reasons) {
      if (reason.kind === "price_drop") drops.push(formatReason(reason, deal.listing.priceUsd));
      else if (reason.kind === "comp") comps.push(formatReason(reason, deal.listing.priceUsd));
    }
  }
  return { drops, comps };
}

async function setRates(jpyPerUsd: number): Promise<void> {
  const result = await fx.refreshFxRates(store, async () => ({
    result: "success",
    base_code: "USD",
    rates: { USD: 1, JPY: jpyPerUsd },
  }));
  expect(result.source).toBe("live");
}

describe("stored reasons survive an FX move", () => {
  it("renders no inverted drop and no negative comp at any rate", async () => {
    // One comp-eligible set (three USD comps in the candidate's band) so the
    // real scorer emits a native comp median.
    for (const id of ["c1", "c2", "c3"]) {
      store.upsertListing(
        normalizeListing({
          market: "grailed",
          id,
          title: "kapital bandana jacket",
          price: 124,
          currency: "USD",
          url: `https://example.com/${id}`,
        }),
      );
    }
    store.upsertListing(jpy("cand", "kapital bandana jacket", 12_245));

    // Drops in every shape a store can hold. Each listing's current price is
    // below its recorded from-price, so every line is a real drop.
    const native = jpy("d-native", "cdg tee native", 8_000);
    const structured = jpy("d-usd", "cdg tee structured", 8_000);
    const prose = jpy("d-prose", "cdg tee prose", 8_000);
    for (const listing of [native, structured, prose]) store.upsertListing(listing);
    store.recordDeal({
      listing: native,
      proxy: {},
      reasons: [{ kind: "price_drop", wasPrice: 12_000, wasCurrency: "JPY" }],
      score: 55,
    });
    store.recordDeal({
      listing: structured,
      proxy: {},
      reasons: [{ kind: "price_drop", wasUsd: WAS_USD }],
      score: 55,
    });
    store.recordDeal({
      listing: prose,
      proxy: {},
      reasons: [{ kind: "price_drop", detail: `dropped from $${WAS_USD} to $51.61` }],
      score: 55,
    });

    rebuild();

    // The rebuild must leave nothing on a frozen USD reference.
    const stored = store.recentDeals(["all"], 1000).flatMap((deal) => deal.reasons);
    const dropsStored = stored.filter((r) => r.kind === "price_drop");
    expect(dropsStored.length).toBeGreaterThanOrEqual(3);
    expect(dropsStored.every((r) => r.wasPrice !== undefined && r.wasUsd === undefined)).toBe(true);
    const compsStored = stored.filter((r) => r.kind === "comp");
    expect(compsStored.length).toBeGreaterThanOrEqual(1);
    expect(compsStored.every((r) => r.medianPrice !== undefined && r.medianUsd === undefined)).toBe(true);

    // Sweep the whole store at four vintages, re-reading per vintage.
    for (const jpyPerUsd of [155, 170, 250, 100]) {
      await setRates(jpyPerUsd);
      const { drops, comps } = renderAllReasons();

      expect(drops.length, `drops at JPY ${jpyPerUsd}`).toBeGreaterThanOrEqual(3);
      expect(comps.length, `comps at JPY ${jpyPerUsd}`).toBeGreaterThanOrEqual(1);

      for (const line of drops) {
        const match = DROP.exec(line);
        expect(match, `unparsable drop at JPY ${jpyPerUsd}: ${line}`).not.toBeNull();
        expect(Number(match![1]), `inverted drop at JPY ${jpyPerUsd}: ${line}`).toBeGreaterThan(
          Number(match![2]),
        );
      }
      for (const line of comps) {
        const match = COMP.exec(line);
        expect(match, `unparsable comp at JPY ${jpyPerUsd}: ${line}`).not.toBeNull();
        expect(Number(match![1]), `negative comp at JPY ${jpyPerUsd}: ${line}`).toBeGreaterThan(0);
      }
    }
  });

  it("would reject a frozen-USD reference, so the sweep is not vacuous", () => {
    // A recorded USD from-price compared against a re-derived price is exactly
    // what the native storage removes: it reads as a drop that never happened.
    const frozen: DealReason = { kind: "price_drop", wasUsd: 50 };
    const line = formatReason(frozen, 80);
    expect(line).toBe("dropped from $50 to $80");
    const match = DROP.exec(line)!;
    expect(Number(match[1])).toBeLessThanOrEqual(Number(match[2]));
  });
});
