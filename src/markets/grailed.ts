import type { Listing, MarketId } from "../types.js";
import { normalizeListing } from "../core/normalize.js";
import type { MarketAdapter } from "./types.js";
import type { HttpClient } from "../core/http.js";
import { fetchJsonViaBrowser } from "../core/browser.js";
import { logger } from "../logger.js";

/**
 * Grailed adapter — unofficial JSON search endpoint (no key required).
 * Endpoint shape is community-documented; response parsing is defensive.
 */
interface GrailedListing {
  id: number | string;
  title: string;
  designer_name?: string;
  size?: string;
  price?: number; // USD
  image?: string;
  url?: string;
  created_at?: string;
}

export class GrailedAdapter implements MarketAdapter {
  readonly id: MarketId = "grailed";

  constructor(
    private readonly http: HttpClient,
    private readonly playwrightExecutablePath?: string,
  ) {}

  searchUrl(query: string): string {
    const params = new URLSearchParams({
      page: "1",
      query,
      sort: "newest",
      currency: "USD",
      "sizeRows[]": "all",
    });
    return `https://www.grailed.com/api/products/search?${params.toString()}`;
  }

  async search(query: string, opts?: { maxItems?: number }): Promise<Listing[]> {
    const max = opts?.maxItems ?? 50;
    try {
      // Grailed sits behind Cloudflare; plain HTTP gets 403. Fetch the JSON
      // API from inside a real browser page so the challenge/cookies apply.
      const json = await fetchJsonViaBrowser<{ data?: GrailedListing[] }>(
        "https://www.grailed.com/",
        this.searchUrl(query).replace("https://www.grailed.com", ""),
        { executablePath: this.playwrightExecutablePath, timeoutMs: 30_000 },
      );
      const items = Array.isArray(json?.data) ? json.data : [];
      const out: Listing[] = [];
      for (const it of items.slice(0, max)) {
        if (it.price === undefined || !it.title || !it.id) continue;
        out.push(
          normalizeListing({
            id: String(it.id),
            market: "grailed",
            title: it.title,
            price: it.price,
            currency: "USD",
            url: it.url?.startsWith("http") ? it.url : `https://www.grailed.com${it.url ?? `/listings/${it.id}`}`,
            imageUrl: it.image?.startsWith("http") ? it.image : it.image ? `https:${it.image}` : undefined,
            size: it.size || undefined,
          }),
        );
      }
      return out;
    } catch (err) {
      // Log and rethrow. Returning [] here once made a Cloudflare block
      // indistinguishable from an empty result: market health recorded a
      // successful round with 0 items ("✓ 0/24h"), and the poller marked the
      // term a completed short page, recording false sold-or-gone absences at
      // cycle wrap. A throw reaches the poller's catch, which stamps ok:false
      // and drops the term's coverage flag.
      logger.warn({ err, market: this.id, query }, "grailed search failed");
      throw err;
    }
  }
}
