import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { classifyMatchPath, watchFuzzy } from "../src/watch-fuzzy.js";

const NOW = new Date("2026-09-18T12:00:00Z").getTime();

describe("classifyMatchPath", () => {
  it("exact: catalog alias present", () => {
    expect(classifyMatchPath("COMME des GARÇONS wallet tee")).toBe("exact");
    expect(classifyMatchPath("ワイズ Y's チュニック")).toBe("exact");
  });

  it("fuzzy: misspelling no alias covers", () => {
    expect(classifyMatchPath("Yoji Yamamoto POUR HOMME coat size 3")).toBe("fuzzy");
    expect(classifyMatchPath("90s ISSEYMIYAKE ストレッチ M")).toBe("fuzzy");
  });

  it("none: non-catalog brand", () => {
    expect(classifyMatchPath("McGregor vintage sweater")).toBe("none");
  });
});

describe("watchFuzzy", () => {
  const dir = mkdtempSync(join(tmpdir(), "watch-fuzzy-"));
  const dbPath = join(dir, "watch.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE listings (key TEXT PRIMARY KEY, title TEXT NOT NULL, brandKey TEXT, size TEXT, foundAt TEXT NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO listings (key, title, brandKey, size, foundAt) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("m:1", "cdg tee", "cdg", "M", new Date(NOW).toISOString());
  insert.run("m:2", "Yoji Yamamoto coat", "yohji", "3", new Date(NOW - 1000).toISOString());
  insert.run("m:3", "McGregor sweater", null, null, new Date(NOW - 2000).toISOString());
  insert.run("m:4", "old cdg jacket", "cdg", null, new Date(NOW - 48 * 3_600_000).toISOString());
  db.close();

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("classifies the window and reports fuzzy rows", () => {
    const res = watchFuzzy(dbPath, new Date(NOW - 3_600_000).toISOString());
    expect(res.total).toBe(3); // the 48h-old row is outside the window
    expect(res.paths).toEqual({ exact: 1, fuzzy: 1, none: 1 });
    expect(res.fuzzyRows).toHaveLength(1);
    expect(res.fuzzyRows[0]).toMatchObject({ key: "m:2", brandKey: "yohji", size: "3" });
  });

  it("returns nothing for an empty window", () => {
    const res = watchFuzzy(dbPath, new Date(NOW + 3_600_000).toISOString());
    expect(res.total).toBe(0);
    expect(res.fuzzyRows).toHaveLength(0);
  });
});
