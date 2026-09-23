/**
 * Extract/evaluation pipeline version.
 *
 * Every stored listing and deal is stamped with the version of the pipeline
 * that produced it. Bump this whenever the code that derives stored values
 * changes (brand catalog, fuzzy matcher, size extraction, threshold rules,
 * how a deal's reasons are built) and the boot-time recompute
 * (core/recompute.ts) will bring every stale row up to date — no manual
 * backfills.
 *
 * A bump re-evaluates each stale row, so deals can also be added or dropped;
 * that is the mechanism working as designed, not collateral.
 *
 * History:
 *   1 — versioning introduced; matchers as of this commit (fuzzy brand
 *       fallback, Y's catalog + rule, guarded extractSize).
 *       Rows stamped 0 predate versioning ("unknown") and are always stale.
 *   2 — deal reasons carry their parameters instead of a rendered sentence,
 *       so surfaces price them at read time. Stored rows carry prose baked in
 *       at the rate of the day, which re-derivation replaces.
 *   3 — threshold notes stop restating the rule's cap. The cap lives only in
 *       `maxUsd` and is printed by the reason line; a figure in the note went
 *       stale the moment the cap changed. Rebuilding replaces notes baked in
 *       under the old wording.
 *   4 — comp medians are stored native (amount + currency) and converted at the
 *       rate in force when rendered, so an FX move cannot push a candidate
 *       above its own median and invert the sentence. Rebuilding replaces the
 *       USD medians stored before this.
 *   5 — the same for a carried price-drop: its recorded USD from-price is
 *       converted to the native amount using the rate the row was written
 *       under, so an FX move cannot push the "from" number past the "to" one.
 *   6 — 5 also covers drops whose from-price survives only inside an older
 *       prose line, not just `wasUsd`.
 *   7 — condition-aware threshold rules: degraded conditions (used/junk)
 *       default to half the brand cap unless a rule sets conditionCaps, and
 *       the condition extractor now recognizes junk/damaged grades. Rules
 *       without caps and unlabeled titles behave exactly as before.
 */
export const PIPELINE_VERSION = 7;
