/**
 * How money is written, everywhere: deal cards, reason lines, Discord embeds.
 *
 * Exact to the cent, with the cents dropped only when they are zero. That is one
 * rule with no thresholds to tune, and it means the amount a reader sees is the
 * amount — so no two surfaces can disagree about the same number and a sentence
 * cannot contradict itself. Rounding is what printed "price $0 ≤ $350" beside a
 * 1-yen listing's card and "dropped from $13 to $13" for a 23-cent drop.
 *
 * The one thing it does not do is group thousands ("$1234.56"), matching how
 * these surfaces have always printed USD.
 */
export function formatUsd(amount: number): string {
  return `$${amount.toFixed(2).replace(/\.00$/, "")}`;
}
