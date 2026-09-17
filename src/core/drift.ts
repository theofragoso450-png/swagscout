import type { MarketId } from "../types.js";
import { matchBrand } from "../config/brands.js";
import { extractSize } from "./normalize.js";

/** Markets whose adapters pass an explicit size from the source API. For
 *  these, extractSize is not the ingest-time source of truth, so size is
 *  not drift-checked (the brand check still applies). */
const EXPLICIT_SIZE_MARKETS: ReadonlySet<MarketId> = new Set(["grailed"]);

export interface DriftInput {
  /** listing key (`${market}:${id}`) — echoed back on mismatches */
  key: string;
  market: MarketId;
  title: string;
  brandKey: string | null;
  size: string | null;
}

export interface DriftRow {
  key: string;
  field: "brandKey" | "size";
  stored: string | null;
  computed: string | null;
}

/**
 * Recompute brand/size from each title with the CURRENT matchers and
 * compare with the stored values. Empty result = zero drift, i.e. the
 * running build's matcher is the one that did the ingest work.
 */
export function findDrift(rows: DriftInput[]): DriftRow[] {
  const out: DriftRow[] = [];
  for (const r of rows) {
    const computedBrand = matchBrand(r.title)?.brandKey ?? null;
    if (computedBrand !== r.brandKey) {
      out.push({ key: r.key, field: "brandKey", stored: r.brandKey, computed: computedBrand });
    }
    if (EXPLICIT_SIZE_MARKETS.has(r.market)) continue;
    const computedSize = extractSize(r.title) ?? null;
    if (computedSize !== r.size) {
      out.push({ key: r.key, field: "size", stored: r.size, computed: computedSize });
    }
  }
  return out;
}
