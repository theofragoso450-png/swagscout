import { describe, expect, it, vi, afterEach } from "vitest";
import { YahooAuctionsAdapter } from "../src/markets/yahooAuctions.js";
import { RakumaAdapter } from "../src/markets/rakuma.js";
import { EbayAdapter } from "../src/markets/ebay.js";
import { MercariAdapter } from "../src/markets/mercari.js";
import type { HttpClient } from "../src/core/http.js";

/**
 * No market may die silently: a transport failure must REJECT from search()
 * so the poller's catch stamps market health ok:false and drops the failed
 * term's coverage flag. Returning [] made a dead market read as a healthy
 * empty one (the #58 defect, applied to the remaining adapters).
 */

const FAIL = (msg = "GET https://market.test → 503: blocked") =>
  ({ getText: vi.fn().mockRejectedValue(new Error(msg)), getJson: vi.fn().mockRejectedValue(new Error(msg)) }) as unknown as HttpClient;
const OK = (listings: unknown[]) =>
  ({ getText: vi.fn().mockResolvedValue(JSON.stringify(listings)), getJson: vi.fn().mockResolvedValue({ items: listings }) }) as unknown as HttpClient;

afterEach(() => vi.restoreAllMocks());

describe("adapters reject on transport failure (no silent death)", () => {
  it("yahoo rejects when getText fails", async () => {
    await expect(new YahooAuctionsAdapter(FAIL()).search("cdg")).rejects.toThrow(/503/);
  });

  it("rakuma rejects when getText fails", async () => {
    await expect(new RakumaAdapter(FAIL()).search("cdg")).rejects.toThrow(/503/);
  });

  it("ebay rejects when the API call fails (configured adapter)", async () => {
    await expect(new EbayAdapter(FAIL(), "app", "cert").search("cdg")).rejects.toThrow();
  });

  it("ebay still returns [] when not configured — absence of keys is not a failure", async () => {
    const out = await new EbayAdapter(FAIL()).search("cdg");
    expect(out).toEqual([]);
  });

  it("mercari throws only when BOTH layers fail; a real empty layer is not an error", async () => {
    const adapter = new MercariAdapter(FAIL());
    const bothFail = adapter as unknown as {
      searchViaBrowser: (q: string, m: number) => Promise<Listing[] | null>;
      searchViaApi: (q: string, m: number) => Promise<Listing[] | null>;
    };
    vi.spyOn(bothFail, "searchViaBrowser").mockResolvedValue(null);
    vi.spyOn(bothFail, "searchViaApi").mockResolvedValue(null);
    await expect(adapter.search("cdg")).rejects.toThrow(/both failed/);
  });

  it("mercari falls back to the json api when the browser layer fails", async () => {
    const adapter = new MercariAdapter(OK([{ id: "m123", name: "cdg tee", price: 1000 }]));
    const layers = adapter as unknown as {
      searchViaBrowser: (q: string, m: number) => Promise<Listing[] | null>;
      searchViaApi: (q: string, m: number) => Promise<Listing[] | null>;
    };
    vi.spyOn(layers, "searchViaBrowser").mockResolvedValue(null);
    const out = await adapter.search("cdg");
    expect(out.length).toBe(1);
    expect(out[0]?.market).toBe("mercari");
  });

  it("mercari returns [] without calling the api when the browser layer is legitimately empty", async () => {
    const adapter = new MercariAdapter(FAIL());
    const layers = adapter as unknown as {
      searchViaBrowser: (q: string, m: number) => Promise<Listing[] | null>;
      searchViaApi: ReturnType<typeof vi.fn>;
    };
    vi.spyOn(layers, "searchViaBrowser").mockResolvedValue([]);
    vi.spyOn(layers, "searchViaApi").mockResolvedValue([]);
    const out = await adapter.search("cdg");
    expect(out).toEqual([]);
    // Browser layer "succeeded" with [], so the API layer must not be consulted.
    expect(layers.searchViaApi).not.toHaveBeenCalled();
  });

  it("mercari returns the browser layer's items when it succeeds", async () => {
    const adapter = new MercariAdapter(FAIL());
    const layers = adapter as unknown as {
      searchViaBrowser: (q: string, m: number) => Promise<Listing[] | null>;
    };
    vi.spyOn(layers, "searchViaBrowser").mockResolvedValue([
      { id: "9", market: "mercari", title: "cdg", brandKey: "cdg", price: 900, currency: "JPY", priceUsd: 6, url: "https://jp.mercari.com/item/m9", foundAt: new Date().toISOString() },
    ]);
    const out = await adapter.search("cdg");
    expect(out).toHaveLength(1);
  });
});
