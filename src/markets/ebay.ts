import { request } from "undici";
import { dispatcher } from "../core/http.js";
import type { Listing, MarketId } from "../types.js";
import { normalizeListing } from "../core/normalize.js";
import type { MarketAdapter } from "./types.js";
import type { HttpClient } from "../core/http.js";
import { logger } from "../logger.js";

/**
 * eBay adapter — official Browse API (OAuth2 client credentials).
 * The legacy Finding API was decommissioned in Feb 2025; Browse is the way.
 */
interface EbayItemSummary {
  itemId: string;
  title: string;
  price?: { value?: string; currency?: string };
  itemWebUrl?: string;
  thumbnailImages?: Array<{ imageUrl?: string }>;
  itemEndDate?: string;
}

interface BrowseSearchResponse {
  itemSummaries?: EbayItemSummary[];
}

export class EbayAdapter implements MarketAdapter {
  readonly id: MarketId = "ebay";
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly appId?: string,
    private readonly certId?: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.appId && this.certId);
  }

  searchUrl(query: string): string {
    return `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=50&sort=newlyListed`;
  }

  private async fetchToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    if (!this.appId || !this.certId) throw new Error("eBay credentials not configured");

    const basic = Buffer.from(`${this.appId}:${this.certId}`).toString("base64");
    const res = await request("https://api.ebay.com/identity/v1/oauth2/token", {
      method: "POST",
      dispatcher,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      headersTimeout: 15_000,
      bodyTimeout: 15_000,
    });
    const body = (await res.body.json()) as { access_token?: string; expires_in?: number };
    if (res.statusCode >= 400 || !body.access_token) {
      throw new Error(`eBay OAuth failed: ${res.statusCode}`);
    }
    this.token = body.access_token;
    this.tokenExpiresAt = Date.now() + (body.expires_in ?? 7200) * 1000;
    return this.token;
  }

  async search(query: string, opts?: { maxItems?: number }): Promise<Listing[]> {
    if (!this.enabled) return [];
    const max = opts?.maxItems ?? 50;
    try {
      const token = await this.fetchToken();
      const json = await this.http.getJson<BrowseSearchResponse>(this.searchUrl(query), {
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
        },
        timeoutMs: 15_000,
      });
      const items = json.itemSummaries ?? [];
      const out: Listing[] = [];
      for (const it of items.slice(0, max)) {
        const value = it.price?.value ? Number(it.price.value) : NaN;
        if (!Number.isFinite(value) || !it.itemId || !it.title) continue;
        // EBAY_US marketplace returns USD prices
        out.push(
          normalizeListing({
            id: it.itemId,
            market: "ebay",
            title: it.title,
            price: value,
            currency: "USD",
            url: it.itemWebUrl ?? `https://www.ebay.com/itm/${it.itemId}`,
            imageUrl: it.thumbnailImages?.[0]?.imageUrl,
            endsAt: it.itemEndDate,
          }),
        );
      }
      return out;
    } catch (err) {
      // Log and rethrow — see yahooAuctions.ts. A swallowed failure made a
      // dead market read as a healthy empty one. (The not-configured case
      // above still returns [] before this point: that is genuinely "no
      // market", not a failure.)
      logger.warn({ err, market: this.id, query }, "ebay search failed");
      throw err;
    }
  }
}
