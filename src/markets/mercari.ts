import * as cheerio from "cheerio";
import type { Listing, MarketId } from "../types.js";
import { normalizeListing } from "../core/normalize.js";
import type { MarketAdapter } from "./types.js";
import type { HttpClient } from "../core/http.js";
import { renderPage } from "../core/browser.js";
import { logger } from "../logger.js";

/**
 * Mercari JP adapter.
 *
 * Primary path: hit the SPA's internal JSON search API with generated tokens.
 * Fallback: render the SPA in a headless browser and scrape the DOM.
 * This is the flakiest market — failures degrade gracefully and never crash
 * the poller (circuit breaker lives in the poller).
 */

interface MercariItem {
  id: string;
  name: string;
  price: number;
  photo?: string;
  status?: string;
  created?: number;
}

const MERCARI_BASE = "https://jp.mercari.com";

function generateCsrfToken(): string {
  // The SPA derives a token from a seeded PRNG; a stable UUID-format token
  // with plausible entropy is accepted for read endpoints.
  const hex = "0123456789abcdef";
  let t = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) t += "-";
    else if (v4Positions.has(i)) t += "4";
    else if (variantPositions.has(i)) {
      t += hex[Math.floor(Math.random() * 4) + 8];
    } else t += hex[Math.floor(Math.random() * 16)];
  }
  return t;
}

const v4Positions = new Set([14]);
const variantPositions = new Set([19]);

export class MercariAdapter implements MarketAdapter {
  readonly id: MarketId = "mercari";

  constructor(
    private readonly http: HttpClient,
    private readonly playwrightExecutablePath?: string,
  ) {}

  searchUrl(query: string): string {
    return `${MERCARI_BASE}/search/?keyword=${encodeURIComponent(query)}`;
  }

  async search(query: string, opts?: { maxItems?: number }): Promise<Listing[]> {
    const max = opts?.maxItems ?? 40;
    // Browser-first: the SPA route works reliably in a real browser, while the
    // public JSON API version drifts (currently returns UnsupportedVersion).
    const items = await this.searchViaBrowser(query, max);
    if (items.length === 0) {
      logger.info({ market: this.id, query }, "mercari browser empty, trying json api");
      return (await this.searchViaApi(query, max)).slice(0, max);
    }
    return items.slice(0, max);
  }

  private async searchViaApi(query: string, max: number): Promise<Listing[]> {
    try {
      const params = new URLSearchParams({
        keyword: query,
        page: "1",
        status: "on_sale",
        sort: "created_time",
        order: "desc",
      });
      const url = `https://api.mercari.jp/v2/entities:search?${params.toString()}`;
      const json = await this.http.getJson<{
        items?: MercariItem[];
        data?: MercariItem[];
      }>(url, {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          ...(process.env.MERCARI_X_CSRF_TOKEN ? { "X-CSRFTOKEN": process.env.MERCARI_X_CSRF_TOKEN } : { "X-CSRFTOKEN": generateCsrfToken() }),
        },
        timeoutMs: 15_000,
        retries: 1,
      });
      const items = json.items ?? json.data ?? [];
      return items
        .filter((it) => it && it.id && it.name && it.price > 0)
        .slice(0, max)
        .map((it) => {
          // Canonical numeric id (API ids may arrive with an "m" prefix);
          // URLs use the real site's /item/m<numeric> shape — same mapping
          // as the DOM path so both feed one dedupe key.
          const id = String(it.id).replace(/^m/, "");
          return normalizeListing({
            id,
            market: "mercari",
            title: it.name,
            price: it.price,
            currency: "JPY",
            url: `${MERCARI_BASE}/item/m${id}`,
            imageUrl: it.photo,
          });
        });
    } catch (err) {
      logger.debug({ err, market: this.id }, "mercari json api failed");
      return [];
    }
  }

  private async searchViaBrowser(query: string, max: number): Promise<Listing[]> {
    try {
      const html = await renderPage(this.searchUrl(query), {
        executablePath: this.playwrightExecutablePath,
        timeoutMs: 40_000,
        waitForSelector: "li[data-testid='item-cell']",
        selectorTimeoutMs: 15_000,
      });
      return this.parseHtml(html).slice(0, max);
    } catch (err) {
      logger.debug({ err, market: this.id, query }, "mercari browser fallback failed");
      return [];
    }
  }

  parseHtml(html: string): Listing[] {
    const $ = cheerio.load(html);
    const out: Listing[] = [];
    const seen = new Set<string>();
    $("li[data-testid='item-cell']").each((_, el) => {
      if (out.length >= 60) return false;
      const $cell = $(el);
      const $a = $cell.find("a[data-testid='thumbnail-link']").first();
      const href = $a.attr("href") ?? "";
      // Canonical numeric id: hrefs often carry an "m" prefix (/item/m123…).
      // Strip it so DOM and API paths dedupe to one row; build the URL from
      // the real site's /item/m<numeric> shape, never the raw captured href.
      const raw = href.match(/\/items?\/(m?\d+)/)?.[1];
      const id = raw?.replace(/^m/, "");
      if (!id) return;
      if (seen.has(id)) return;
      // title/price can sit inside or beside the anchor depending on layout
      const title = $cell.find("[data-testid='thumbnail-item-name']").first().text().trim() || $a.attr("aria-label") || "";
      const priceText = $cell.find("[data-testid='item-tile-price']").first().text().trim();
      const priceNum = Number(priceText.replace(/[^\d]/g, ""));
      if (!title || !Number.isFinite(priceNum) || priceNum <= 0) return;
      seen.add(id);
      const img = $a.find("img").first().attr("src") ?? undefined;
      out.push(
        normalizeListing({
          id,
          market: "mercari",
          title,
          price: priceNum,
          currency: "JPY",
          url: `${MERCARI_BASE}/item/m${id}`,
          imageUrl: img,
        }),
      );
    });
    return out;
  }
}
