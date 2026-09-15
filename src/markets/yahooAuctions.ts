import * as cheerio from "cheerio";
import type { Listing, MarketId } from "../types.js";
import { normalizeListing } from "../core/normalize.js";
import type { MarketAdapter } from "./types.js";
import type { HttpClient } from "../core/http.js";
import { logger } from "../logger.js";

/**
 * Yahoo Auctions Japan adapter — HTML scraping.
 * Searches newest-first and returns raw listings; the poller stops at
 * already-seen items. Relies on YAJ's server-rendered search pages.
 */
export class YahooAuctionsAdapter implements MarketAdapter {
  readonly id: MarketId = "yahoo";

  constructor(private readonly http: HttpClient) {}

  searchUrl(query: string): string {
    // &n=50 → 50 results per page
    return `https://auctions.yahoo.co.jp/search/search?p=${encodeURIComponent(query)}&n=50`;
  }

  async search(query: string, opts?: { maxItems?: number }): Promise<Listing[]> {
    const url = this.searchUrl(query);
    const max = opts?.maxItems ?? 50;
    try {
      const html = await this.http.getText(url, { timeoutMs: 15_000 });
      return this.parse(html).slice(0, max);
    } catch (err) {
      logger.warn({ err, market: this.id, query }, "yahoo search failed");
      return [];
    }
  }

  parse(html: string): Listing[] {
    const $ = cheerio.load(html);
    const out: Listing[] = [];

    $("li.Product").each((_, el) => {
      const $el = $(el);
      const $a = $el.find("a").first();
      const href = $a.attr("href") ?? "";
      const title = $el.find(".Product__titleLink").text().trim();
      const priceText = $el.find(".Product__price").first().text().trim();
      const img = $el.find("img").first().attr("src") ?? "";
      const endsAtText = $el.find(".Product__time").first().text().trim();

      const idMatch = href.match(/auction\/([a-z0-9]+)/i);
      const priceNum = parseYen(priceText);
      const id = idMatch?.[1];
      if (!id || !title || priceNum === null) return;
      out.push(
        normalizeListing({
          id,
          market: "yahoo",
          title,
          price: priceNum,
          currency: "JPY",
          url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
          imageUrl: img.startsWith("//") ? `https:${img}` : img,
          endsAt: endsAtText ? parseJpRelative(endsAtText) : undefined,
        }),
      );
    });
    return out;
  }
}

function parseYen(text: string): number | null {
  const cleaned = text.replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** YAJ shows "残り◯時間" / "残り◯分" — convert to an ISO timestamp. */
export function parseJpRelative(text: string): string | undefined {
  const now = Date.now();
  const h = text.match(/残り\s*(\d+)\s*時間/);
  if (h) return new Date(now + Number(h[1]) * 3_600_000).toISOString();
  const m = text.match(/残り\s*(\d+)\s*分/);
  if (m) return new Date(now + Number(m[1]) * 60_000).toISOString();
  const d = text.match(/残り\s*(\d+)\s*日/);
  if (d) return new Date(now + Number(d[1]) * 86_400_000).toISOString();
  return undefined;
}
