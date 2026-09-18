import { describe, expect, it } from "vitest";
import { Poller } from "../src/core/poller.js";
import { Store } from "../src/core/store.js";
import type { MarketAdapter } from "../src/markets/types.js";
import type { Listing, MarketId } from "../src/types.js";

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: "x1",
    market: "mercari",
    title: "cdg tee",
    brandKey: "cdg",
    price: 930,
    currency: "JPY",
    priceUsd: 6,
    url: "https://jp.mercari.com/item/x1",
    foundAt: new Date().toISOString(),
    ...over,
  };
}

const POLL_SECONDS: Record<MarketId, number> = {
  yahoo: 30,
  grailed: 45,
  ebay: 60,
  mercari: 90,
  rakuma: 90,
};

type Page = Listing[];

/**
 * Queue-driven poller harness: each `run()` consumes the next scripted
 * return — an array of listings, or an Error to fail the poll. One poller
 * instance for the whole scenario, so cycle memory (roundSeen/roundDoneTerms)
 * persists across ticks exactly as it does in production.
 *
 * Cycle arithmetic: cdg has TWO search terms ("コムデギャルソン", "cdg"), so
 * one query cycle = two ticks, with the wrap (absence finalization) on the
 * second. Scripts below are written tick-by-tick.
 */
function harness(store: Store, script: Array<Page | Error>) {
  let step = 0;
  const adapter: MarketAdapter = {
    id: "mercari",
    searchUrl: (q) => q,
    search: async () => {
      const next = script[Math.min(step++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const poller = new Poller(
    store,
    [adapter],
    { pollSeconds: POLL_SECONDS, compRoundUsd: 50, watchKeys: ["cdg"] },
    async () => {},
  );
  return { poller, run: () => poller.pollMarket("mercari") };
}

describe("sold-velocity transitions", () => {
  it("a continuously-seen row is never marked", async () => {
    const store = new Store(":memory:");
    const page = [listing({ id: "a1" })];
    const { poller, run } = harness(store, [page, page]);
    await run();
    await run(); // cycle 1 wraps here
    expect(store.get("mercari", "a1")?.missingSince ?? null).toBeNull();
    poller.stop();
    store.close();
  });

  it("seen-then-absent marks missingSince at cycle wrap; reappearance clears it", async () => {
    const store = new Store(":memory:");
    const { poller, run } = harness(store, [
      [listing({ id: "a1" })], // cycle 1, term 1
      [listing({ id: "a1" })], // cycle 1, term 2 → wrap: seen, unmarked
      [], // cycle 2, term 1: absent
      [], // cycle 2, term 2 → wrap: absent, both terms short → MARK
      [listing({ id: "a1" })], // cycle 3, term 1: seen again → clear on sighting
    ]);
    await run();
    await run();
    await run();
    await run(); // wrap → marked
    const markedAt = store.get("mercari", "a1")?.missingSince;
    expect(typeof markedAt).toBe("string");

    await run(); // sighting clears
    expect(store.get("mercari", "a1")?.missingSince ?? null).toBeNull();
    poller.stop();
    store.close();
  });

  it("a full 50-item page is never treated as a complete observation", async () => {
    const store = new Store(":memory:");
    const { poller, run } = harness(store, [
      [listing({ id: "a1" })], // cycle 1: seen
      [listing({ id: "a1" })], // cycle 1 wrap: seen
      Array.from({ length: 50 }, (_, i) => listing({ id: `f${i}` })), // cycle 2 t1: FULL, a1 unseen
      Array.from({ length: 50 }, (_, i) => listing({ id: `f${i}` })), // cycle 2 t2 → wrap: term FULL → uncovered → no mark
    ]);
    await run();
    await run();
    await run();
    await run();
    expect(store.get("mercari", "a1")?.missingSince ?? null).toBeNull();
    poller.stop();
    store.close();
  });

  it("a full page after a short page invalidates the term's completeness", async () => {
    const store = new Store(":memory:");
    const { poller, run } = harness(store, [
      [listing({ id: "a1" })], // c1 t1: short, seen
      [listing({ id: "a1" })], // c1 t2 → wrap: seen, unmarked
      [], // c2 t1: absent
      [], // c2 t2 → wrap: absent both ticks, both terms short → MARK
      Array.from({ length: 50 }, (_, i) => listing({ id: `f${i}` })), // c3 t1: FULL → completeness invalidated
      Array.from({ length: 50 }, (_, i) => listing({ id: `f${i}` })), // c3 t2 → wrap: uncovered → mark untouched
    ]);
    await run();
    await run();
    await run();
    await run(); // mark happens here (a1 absent from BOTH ticks of c2)
    const markedAt = store.get("mercari", "a1")?.missingSince;
    expect(typeof markedAt).toBe("string");

    await run();
    await run(); // cycle 3 wraps on a FULL page → must NOT touch the mark
    expect(store.get("mercari", "a1")?.missingSince).toBe(markedAt);
    poller.stop();
    store.close();
  });

  it("a failed query drops only its own coverage flag (no mass-marking, others stay covered)", async () => {
    const store = new Store(":memory:");
    const { poller, run } = harness(store, [
      [listing({ id: "a1" })], // c1 t1: short
      [listing({ id: "a1" })], // c1 t2 → wrap: seen
      new Error("market down"), // c2 t1: term 1 fails → its flag dropped
      [], // c2 t2 → wrap: term 1 incomplete → uncovered → no mark
      [listing({ id: "a1" })], // c3 t1: recovery, seen
    ]);
    await run();
    await run();
    await run();
    await run(); // wrap after the failure → no marking despite a1 absent
    expect(store.get("mercari", "a1")?.missingSince ?? null).toBeNull();

    await run(); // seen again, normal operation
    expect(store.get("mercari", "a1")?.missingSince ?? null).toBeNull();
    poller.stop();
    store.close();
  });

  it("missingSince keeps the FIRST absence timestamp (never churns)", async () => {
    const store = new Store(":memory:");
    const { poller, run } = harness(store, [
      [listing({ id: "a1" })], // c1 t1
      [listing({ id: "a1" })], // c1 t2 wrap: seen
      [], // c2 t1
      [], // c2 t2 wrap → MARK at t_wrap
      [], // c3 t1
      [], // c3 t2 wrap: still absent → idempotent, keeps original stamp
    ]);
    await run();
    await run();
    await run();
    await run();
    const first = store.get("mercari", "a1")?.missingSince;
    expect(typeof first).toBe("string");
    await run();
    await run();
    expect(store.get("mercari", "a1")?.missingSince).toBe(first);
    poller.stop();
    store.close();
  });

  it("applyAbsences is idempotent at the store layer", () => {
    const store = new Store(":memory:");
    store.upsertListing(listing({ id: "a1" }));
    const at = new Date().toISOString();
    expect(store.applyAbsences("mercari", at, ["mercari:a1"])).toBe(1);
    expect(store.applyAbsences("mercari", at, ["mercari:a1"])).toBe(0);
    expect(store.get("mercari", "a1")?.missingSince).toBe(at);
    store.close();
  });

  it("clearMissing survives unknown keys and applyAbsences needs a real row", () => {
    const store = new Store(":memory:");
    expect(() => store.clearMissing("mercari:ghost")).not.toThrow();
    expect(store.applyAbsences("mercari", new Date().toISOString(), ["mercari:ghost"])).toBe(0);
    expect(store.countMissing()).toBe(0);
    store.close();
  });
});
