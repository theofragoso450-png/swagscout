import * as cheerio from "cheerio";
import type { Listing, MarketId } from "../types.js";
import { normalizeListing } from "../core/normalize.js";
import type { MarketAdapter } from "./types.js";
import type { HttpClient } from "../core/http.js";
import { logger } from "../logger.js";

/**
 * Rakuma (fril.jp) adapter — HTML scraping of search results.
 *
 * 2026 markup: search pages render `.item-box` cards whose primary link is
 * `a.link_search_image` pointing at `https://item.fril.jp/<hex-hash>` with
 * the listing title in the `title` attribute. The numeric item id appears in
 * the anchor's GA onclick payload (`'dimension1': '<id>'`), which is what
 * proxy services key off. Prices live in `.item-box__item-price` spans with
 * the amount in a `data-content` attribute.
 */
export class RakumaAdapter implements MarketAdapter {
  readonly id: MarketId = "rakuma";

  constructor(private readonly http: HttpClient) {}

  searchUrl(query: string): string {
    return `https://fril.jp/search/${encodeURIComponent(query)}`;
  }

  async search(query: string, opts?: { maxItems?: number }): Promise<Listing[]> {
    const max = opts?.maxItems ?? 40;
    try {
      const html = await this.http.getText(this.searchUrl(query), {
        timeoutMs: 20_000,
        retries: 1,
      });
      return this.parse(html).slice(0, max);
    } catch (err) {
      // Log and rethrow — see yahooAuctions.ts. A swallowed failure made a
      // dead market read as a healthy empty one and poisoned sold-velocity
      // coverage at cycle wrap.
      logger.warn({ err, market: this.id, query }, "rakuma search failed");
      throw err;
    }
  }

  parse(html: string): Listing[] {
    const $ = cheerio.load(html);
    const out: Listing[] = [];
    const seen = new Set<string>();

    $(".item-box").each((_, el) => {
      if (out.length >= 60) return false;
      const $box = $(el);
      const $a = $box.find("a.link_search_image").first();
      const href = $a.attr("href") ?? "";
      const hex = href.match(/item\.fril\.jp\/([0-9a-f]+)/i)?.[1];
      if (!hex) return;

      const title = $a.attr("title")?.trim() ?? "";
      // <span data-content="JPY">¥</span><span data-content="50000">50,000</span>
      let priceNum = NaN;
      $box.find(".item-box__item-price span[data-content]").each((__, span) => {
        const v = $(span).attr("data-content") ?? "";
        if (v !== "JPY" && /^\d[\d,]*$/.test(v)) {
          priceNum = Number(v.replace(/,/g, ""));
          return false;
        }
      });
      if (!title || !Number.isFinite(priceNum) || priceNum <= 0) return;

      // numeric id from the GA payload; fall back to the hex hash
      const onclick = $a.attr("onclick") ?? "";
      const numeric = onclick.match(/'dimension1':\s*'(\d+)'/)?.[1] ??
        $box.html()?.match(/item_id(?:&quot;|\"|')+:(?:&quot;|\"|')+(\d+)/)?.[1];
      const id = numeric ?? hex;
      if (seen.has(id)) return;
      seen.add(id);

      const img =
        $box.find("img").first().attr("data-src") ??
        $box.find("img").first().attr("src");
      out.push(
        normalizeListing({
          id,
          market: "rakuma",
          title,
          price: priceNum,
          currency: "JPY",
          url: `https://item.fril.jp/${hex}`,
          imageUrl: img && img.startsWith("//") ? `https:${img}` : img || undefined,
        }),
      );
    });
    return out;
  }
}
