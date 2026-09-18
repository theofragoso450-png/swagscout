/**
 * Extract/evaluation pipeline version.
 *
 * Every stored listing and deal is stamped with the version of the pipeline
 * that produced it. Bump this whenever matching/scoring behavior changes
 * (brand catalog, fuzzy matcher, size extraction, threshold rules) and the
 * boot-time recompute (core/recompute.ts) will bring every stale row up to
 * date — no manual backfills.
 *
 * History:
 *   1 — versioning introduced; matchers as of this commit (fuzzy brand
 *       fallback, Y's catalog + rule, guarded extractSize).
 *       Rows stamped 0 predate versioning ("unknown") and are always stale.
 */
export const PIPELINE_VERSION = 1;
