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
 */
export const PIPELINE_VERSION = 3;
