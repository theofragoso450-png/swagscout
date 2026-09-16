import type { Deal } from "../types.js";
import type { Subscription } from "../core/store.js";

/**
 * Pure subscription match used by alert routing and /deals: brand watch
 * ("all" = wildcard), minimum score, and an optional exact-size filter
 * (case-insensitive; null/undefined = any size).
 */
export function dealMatchesSubscription(deal: Deal, sub: Subscription): boolean {
  if (sub.watch !== "all" && deal.listing.brandKey !== sub.watch) return false;
  if (deal.score < sub.minScore) return false;
  if (sub.size) {
    const size = deal.listing.size?.toLowerCase();
    if (!size || size !== sub.size.toLowerCase()) return false;
  }
  return true;
}
