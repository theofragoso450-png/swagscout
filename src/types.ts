export type MarketId = "yahoo" | "grailed" | "ebay" | "mercari" | "rakuma";

export const ALL_MARKETS: MarketId[] = ["yahoo", "grailed", "ebay", "mercari", "rakuma"];

export const MARKET_LABEL: Record<MarketId, string> = {
  yahoo: "Yahoo Auctions JP",
  grailed: "Grailed",
  ebay: "eBay",
  mercari: "Mercari JP",
  rakuma: "Rakuma",
};

export const MARKET_FLAG: Record<MarketId, string> = {
  yahoo: "🇯🇵",
  grailed: "🇺🇸",
  ebay: "🇺🇸",
  mercari: "🇯🇵",
  rakuma: "🇯🇵",
};

export interface Listing {
  /** Stable unique id within the market (e.g. auction id, item id). */
  id: string;
  market: MarketId;
  title: string;
  /** Matched brand key (slug) from the brand catalog, if any. */
  brandKey?: string;
  /** Raw brand string as found on the listing, if any. */
  brandRaw?: string;
  /** Short item descriptor (e.g. "thermal long sleeve tee"). */
  item?: string;
  size?: string;
  /** Listing end time, when the market exposes one (auctions). ISO string. */
  endsAt?: string;
  price: number;
  currency: "JPY" | "USD";
  priceUsd: number;
  url: string;
  imageUrl?: string;
  /** ISO string when the listing was first seen by the bot. */
  foundAt: string;
}

export interface ProxyLinks {
  buyee?: string;
  zenmarket?: string;
  sendico?: string;
}

export interface CompSnapshot {
  market: MarketId;
  priceUsd: number;
  url: string;
}

export interface CompMatch {
  roundUsd: number;
  medianUsd: number;
  sampleSize: number;
  samples: CompSnapshot[];
  discountPct: number;
}

export interface Deal {
  listing: Listing;
  proxy: ProxyLinks;
  /** "threshold" = static price rule; "comp" = cross-market underprice. */
  reasons: DealReason[];
  score: number;
  comp?: CompMatch;
}

export interface DealReason {
  kind: "threshold" | "comp" | "price_drop";
  detail: string;
}

export interface PollResult {
  market: MarketId;
  fetched: number;
  newListings: number;
  priceDrops: number;
  deals: Deal[];
  error?: string;
}
