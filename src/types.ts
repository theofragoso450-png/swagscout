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
  /** Sold-velocity: set when the listing is absent from complete poll rounds of its market (absent-since timestamp). Undefined while live. */
  missingSince?: string;
  /** Normalized condition derived from the marketplace's title markers. */
  condition?: string;
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

/**
 * Why a listing is a deal, as the decision's parameters rather than a rendered
 * sentence.
 *
 * Price-derived values are stored NATIVE — the amount plus the currency it was
 * drawn from — never as a USD figure. A USD amount frozen at decision time
 * drifts against the card's own price the moment the rate moves, which could
 * invert the sentence it is part of ("dropped from $10 to $11", "-3% below a
 * median"). core/reasons.ts converts the native amount at the rate in force —
 * the same rate the displayed price is derived at — so the two sides of every
 * comparison are on one vintage by construction.
 */
export interface DealReason {
  kind: "threshold" | "comp" | "price_drop";
  /** threshold: the rule's USD cap (a configured number, not a conversion). */
  capUsd?: number;
  /** threshold: the rule's human note. */
  note?: string;
  /** comp: the comparison set's median, native to `medianCurrency`. */
  medianPrice?: number;
  medianCurrency?: string;
  /** comp: how many listings the median was drawn from. */
  sampleSize?: number;
  /** price_drop: the price observed before the drop, native to `wasCurrency`. */
  wasPrice?: number;
  wasCurrency?: string;
  /** comp: a USD median recorded before reasons carried native amounts. */
  medianUsd?: number;
  /** price_drop: a USD from-price recorded before reasons carried native amounts. */
  wasUsd?: number;
  /**
   * A rendered line, for reasons with no parameters: every deal stored before
   * reasons carried them, plus callers that supply prose directly. There is
   * nothing to re-render in that case, so it is used as recorded.
   */
  detail?: string;
}

export interface PollResult {
  market: MarketId;
  fetched: number;
  newListings: number;
  priceDrops: number;
  deals: Deal[];
  error?: string;
}
