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
