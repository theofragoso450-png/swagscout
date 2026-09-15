import type { MarketId, Listing } from "../types.js";

/**
 * A MarketAdapter knows how to search one marketplace for a query string and
 * return normalized listings. Poller rotates through queries per market.
 */
export interface MarketAdapter {
  readonly id: MarketId;
  /** Human-readable description of a search URL for logging. */
  searchUrl(query: string): string;
  /** Search the market. Implementations must be resilient (catch their own errors). */
  search(query: string, opts?: { maxItems?: number }): Promise<Listing[]>;
}
