// Fuzzy-watch: classify the brand-matching path (exact / fuzzy / none) taken
// for every listing found since a timestamp, and print the fuzzy-path rows —
// the badly-spelled titles this tool exists to surface.
//
//   npm run watch:fuzzy                       # last 24h
//   npm run watch:fuzzy 2026-09-18T14:00:00Z  # since an ISO timestamp
//   DB_PATH=data/other.sqlite npm run watch:fuzzy
//
// Read-only: opens the store with { readOnly: true } and never writes.
import { DatabaseSync } from "node:sqlite";
import { matchBrand, BRANDS, BRAND_BY_KEY } from "./config/brands.js";

export type MatchPath = "exact" | "fuzzy" | "none";

/** Classify which matchBrand path a title would take, without mutating anything. */
export function classifyMatchPath(title: string): MatchPath {
  const t = title.toLowerCase();
  for (const brand of BRANDS) {
    const aliases = [...(brand.aliases ?? []), ...(brand.jpAliases ?? [])];
    const blocked = brand.negativeJpAliases ?? [];
    for (const alias of aliases) {
      if (t.includes(alias.toLowerCase()) && !blocked.some((n) => t.includes(n.toLowerCase()))) {
        return "exact";
      }
    }
  }
  return matchBrand(title) ? "fuzzy" : "none";
}

export interface WatchResult {
  total: number;
  paths: Record<MatchPath, number>;
  fuzzyRows: Array<{ key: string; title: string; brandKey: string | null; size: string | null }>;
}

/** Classify every listing found since `sinceIso` in the given SQLite file. */
export function watchFuzzy(dbPath: string, sinceIso: string): WatchResult {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT key, title, brandKey, size FROM listings WHERE foundAt >= ? ORDER BY foundAt",
      )
      .all(sinceIso) as Array<{ key: string; title: string; brandKey: string | null; size: string | null }>;

    const paths: Record<MatchPath, number> = { exact: 0, fuzzy: 0, none: 0 };
    const fuzzyRows: WatchResult["fuzzyRows"] = [];
    for (const r of rows) {
      const p = classifyMatchPath(r.title);
      paths[p]++;
      if (p === "fuzzy") fuzzyRows.push(r);
    }
    return { total: rows.length, paths, fuzzyRows };
  } finally {
    db.close();
  }
}

function isMain(): boolean {
  return Boolean(process.argv[1]?.replace(/\\/g, "/").endsWith("src/watch-fuzzy.ts"));
}

if (isMain()) {
  const arg = process.argv[2];
  let since: string;
  if (arg) {
    const t = Date.parse(arg);
    if (!Number.isFinite(t)) {
      console.error(`not a timestamp: ${arg} — pass an ISO date like 2026-09-18T14:00:00Z`);
      process.exit(1);
    }
    since = new Date(t).toISOString();
  } else {
    since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  }

  const dbPath = process.env.DB_PATH ?? "data/swagscout.db";
  const { total, paths, fuzzyRows } = watchFuzzy(dbPath, since);
  console.log(`rows since ${since}: ${total} | paths: ${JSON.stringify(paths)}`);
  for (const r of fuzzyRows) {
    console.log(`FUZZY-CATCH ${r.key} -> ${r.brandKey ?? "null"} (size: ${r.size ?? "-"}) | ${r.title.slice(0, 90)}`);
  }
}
