import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Poller } from "../src/core/poller.js";
import { Store } from "../src/core/store.js";
import { scoreDeal } from "../src/core/score.js";
import { HttpClient } from "../src/core/http.js";
import { MercariAdapter } from "../src/markets/mercari.js";
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

describe("poller price-drop scoring (deal.score must match the reasons it notifies with)", () => {
  it("a price_drop reason present at notify/record time is reflected in deal.score", async () => {
    const store = new Store(":memory:");
    // Already-seen listing at a higher price → next poll is a price drop.
    store.upsertListing(listing({ id: "p1", price: 1550, priceUsd: 10 }));

    const adapter: MarketAdapter = {
      id: "mercari",
      searchUrl: (q) => q,
      search: async () => [listing({ id: "p1", price: 930, priceUsd: 6 })],
    };
    const poller = new Poller(store, [adapter], { pollSeconds: POLL_SECONDS, compRoundUsd: 50 }, async () => {});
    const res = await poller.pollMarket("mercari");
    store.close();

    expect(res.deals).toHaveLength(1);
    const deal = res.deals[0]!;
    expect(deal.reasons.some((r) => r.kind === "price_drop")).toBe(true);
    // scoreDeal is the documented scoring function; the deal must be scored
    // against the FULL reason list it carries into embeds and min_score gates.
    expect(deal.score).toBe(scoreDeal(deal.listing, deal.reasons, deal.comp));
    expect(deal.score).toBeGreaterThanOrEqual(55); // threshold 40 + price_drop 15
  });
});

describe("http redirect handling", () => {
  it("a redirect chain that exceeds the cap fails instead of returning the redirect body", async () => {
    let port = 0;
    const server: Server = createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${port}${req.url}` });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    try {
      const http = new HttpClient(60);
      await expect(
        http.getText(`http://127.0.0.1:${port}/loop`, { retries: 0, timeoutMs: 3_000 }),
      ).rejects.toThrow(/302/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("mercari item mapping (DOM path and API path must agree)", () => {
  const adapter = new MercariAdapter({} as HttpClient);

  it("derives canonical numeric ids and /item/ urls from DOM hrefs", () => {
    const html =
      '<li data-testid="item-cell">' +
      '<a data-testid="thumbnail-link" href="/item/m10014652704"><img src="https://static.mercdn.net/c/1.jpg"></a>' +
      '<p data-testid="thumbnail-item-name">cdg tee</p>' +
      '<div data-testid="item-tile-price">¥1,000</div>' +
      "</li>";
    const [l] = adapter.parseHtml(html);
    expect(l).toBeDefined();
    expect(l!.id).toBe("10014652704");
    expect(l!.url).toBe("https://jp.mercari.com/item/m10014652704");
  });

  it("api-path items map to the same id and url shape as the DOM path", async () => {
    class StubHttp {
      async getJson<T>(): Promise<T> {
        return {
          items: [{ id: "m20099999999", name: "cdg tee", price: 2000, photo: "https://static.mercdn.net/x.jpg" }],
        } as T;
      }
    }
    const apiAdapter = new MercariAdapter(new StubHttp() as never);
    const api = apiAdapter as unknown as {
      searchViaApi(q: string, max: number): Promise<Listing[]>;
    };
    const [l] = await api.searchViaApi("cdg", 40);
    expect(l).toBeDefined();
    expect(l!.id).toBe("20099999999");
    expect(l!.url).toBe("https://jp.mercari.com/item/m20099999999");
  });
});
