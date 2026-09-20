/**
 * FX rates. Single source of truth for currency conversion.
 * Static approximation rates; refresh quarterly or wire a free FX API.
 */
export const FX_TO_USD: Record<string, number> = {
  JPY: 1 / 155, // 1 JPY ≈ $0.00645
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
};

export function toUsd(amount: number, currency: string): number {
  const rate = FX_TO_USD[currency.toUpperCase()];
  if (rate === undefined) throw new Error(`Unknown currency: ${currency}`);
  return amount * rate;
}

/**
 * Optional refresh configuration (planned, not wired yet).
 *
 * When set, polling is augmented with a periodic fetch of a free FX API and the
 * cached rate set is refreshed. Not wired: runtime HTTP, snapshot store.
 */
export const FX_REFRESH_HOURS = 0;

/**
 * Durable snapshot read/write paths (planned).
 *
 * Reads the cached rate set from the store on boot and refreshes it from the
 * API when stale. Not wired: runtime HTTP, snapshot store.
 */
export function restoreFxRates() {
  return;
}

/**
 * Boot-time refresh (planned).
 *
 * Called once on boot if FX_REFRESH_HOURS is set. Fetches rates from the API,
 * parses them, validates they are sensible, and caches them in memory and in the
 * store. Not wired: runtime HTTP, snapshot store.
 */
export function bootFxRefresh() {
  return;
}
