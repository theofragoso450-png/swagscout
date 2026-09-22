import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The adapter fetches Grailed's JSON from inside a real browser page. Mock the
// browser layer entirely: no network, no Chrome, fully deterministic blocks.
vi.mock("../src/core/browser.js", () => ({
  fetchJsonViaBrowser: vi.fn(),
}));

import { GrailedAdapter } from "../src/markets/grailed.js";
import { Poller } from "../src/core/poller.js";
import { Store } from "../src/core/store.js";
import { fetchJsonViaBrowser } from "../src/core/browser.js";
import type { MarketAdapter } from "../src/markets/types.js";
import type { Listing, MarketId } from "../src/types.js";

const mockedFetch = vi.mocked(fetchJsonViaBrowser);

const POLL_SECONDS: Record<MarketId, number> = {
  yahoo: 30,
  grailed: 45,
  ebay: 60,
  mercari: 90,
  rakuma: 90,
};

/** A blocked round looks like this: page loads (challenge passed), but the
 * in-page API fetch hits Cloudflare's 403 → fetchJsonViaBrowser throws. */
const BLOCK = new Error("fetch /api/products/search?… → 403");

function grailedJsonItem(id: number) {
  return {
    id,
    title: "Comme des Garcons tee",
    designer_name: "Comme des Garcons",
    price: 60,
    size: "M",
  };
}

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swagscout-grailed-block-"));
  dbPath = path.join(dir, "test.db");
  store = new Store(dbPath);
  mockedFetch.mockReset();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function adapter(): GrailedAdapter {
  return new GrailedAdapter({} as never);
}

function grailedPoller(a: MarketAdapter): Poller {
  return new Poller(
    store,
    [a],
    { pollSeconds: POLL_SECONDS, compRoundUsd: 50, watchKeys: ["cdg"] },
    async () => {},
  );
}

function grailedHealth() {
  return store.marketHealth().find((m) => m.market === "grailed")!;
}

describe("Grailed Cloudflare block detection", () => {
  it("a blocked round stamps a failure, not a healthy 0-item success", async () => {
    mockedFetch.mockRejectedValue(BLOCK);

    await expect(adapter().search("cdg")).rejects.toThrow(/403/);

    const poller = grailedPoller(adapter());
    await poller.pollMarket("grailed");

    const h = grailedHealth();
    expect(h.lastRoundOk).toBe(false);
    expect(h.lastRoundAt).not.toBeNull();
    expect(h.lastRoundItems).toBe(0);
  });

  it("a blocked cycle records no sold-or-gone absences (empty result never read as a short page)", async () => {
    // The poisoning path: a block returned [] → fetched 0 < 50 → term marked
    // "done" → at wrap, stored rows absent from the seen-set would be marked
    // missing. Seed a stored listing, block every poll, and assert nothing is
    // marked gone.
    const stored: Listing = {
      id: "kept",
      market: "grailed",
      title: "cdg tee",
      brandKey: "cdg",
      price: 60,
      currency: "USD",
      priceUsd: 60,
      url: "https://www.grailed.com/listings/kept",
      foundAt: new Date().toISOString(),
    };
    store.upsertListing(stored);
    mockedFetch.mockRejectedValue(BLOCK);

    const poller = grailedPoller(adapter());
    for (let i = 0; i < 3; i++) await poller.pollMarket("grailed");

    expect(store.get("grailed", "kept")?.missingSince ?? null).toBeNull();
    expect(grailedHealth().lastRoundOk).toBe(false);
  });

  it("a real empty result stays a clean success", async () => {
    mockedFetch.mockResolvedValue({ data: [] });

    const out = await adapter().search("cdg");
    expect(out).toEqual([]);

    const poller = grailedPoller(adapter());
    await poller.pollMarket("grailed");

    const h = grailedHealth();
    expect(h.lastRoundOk).toBe(true);
    expect(h.lastRoundItems).toBe(0);
  });

  it("a successful round parses items and stamps ok with the fetched count", async () => {
    mockedFetch.mockResolvedValue({ data: [grailedJsonItem(1), grailedJsonItem(2)] });

    const out = await adapter().search("cdg");
    expect(out).toHaveLength(2);
    expect(out[0]?.market).toBe("grailed");
    expect(out[0]?.priceUsd).toBeGreaterThan(0);

    const poller = grailedPoller(adapter());
    await poller.pollMarket("grailed");
    expect(grailedHealth().lastRoundOk).toBe(true);
    expect(grailedHealth().lastRoundItems).toBe(2);
  });

  it("a blocked round drops the term's coverage flag so its brand stays unrecorded", async () => {
    // Success for term A, block for term B: at wrap only A's brands may be
    // covered. If the block leaked through as [], B's brands would too.
    mockedFetch.mockResolvedValueOnce({ data: [grailedJsonItem(1)] });
    mockedFetch.mockRejectedValueOnce(BLOCK);

    const poller = grailedPoller(adapter());
    await poller.pollMarket("grailed"); // term A: success
    await poller.pollMarket("grailed"); // term B: blocked

    expect(grailedHealth().lastRoundOk).toBe(false);
  });
});
