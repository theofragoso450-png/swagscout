import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { startDashboard, type DashboardServer } from "../src/web/server.js";

let dbPath: string;
let store: Store;
let server: DashboardServer | undefined;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-urlsync-")), "test.db");
  store = new Store(dbPath);
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  store.close();
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

async function boot(): Promise<number> {
  server = startDashboard(store, 0, () => "test");
  return server.start();
}

async function page(port: number): Promise<string> {
  return (await fetch(`http://127.0.0.1:${port}/`)).text();
}

describe("dashboard URL sync", () => {
  it("preselects market/brand/condition/sort/q from the querystring on boot", async () => {
    const html = await page(await boot());
    expect(html).toContain("const params = new URLSearchParams(location.search);");
    // size is deliberately absent here: its options load async (next test)
    expect(html).toContain('for (const id of ["market", "brand", "condition", "sort"]) {');
    // preselect only when the value exists as an option — a shared URL with
    // an unknown/renamed value falls back to the "All …" default instead of
    // blanking the select
    expect(html).toContain("if ([...el.options].some((o) => o.value === v)) el.value = v;");
    expect(html).toContain('document.getElementById("q").value = paramVal("q");');
  });

  it("preselects ?size= after the async size rebuild and before the first feed load", async () => {
    const html = await page(await boot());
    // size options don't exist until /api/sizes resolves, so the boot loop
    // can't select them; the boot chain re-applies the param post-rebuild
    expect(html.indexOf("const params = new URLSearchParams")).toBeGreaterThan(-1);
    expect(html.indexOf("const params = new URLSearchParams")).toBeLessThan(
      html.indexOf("async function rebuildSizeOptions"),
    );
    expect(html).toContain(
      "if (v && [...sizeSel.options].some((o) => o.value === v)) sizeSel.value = v;",
    );
    // the initial fetch waits for the preselect, so the first syncUrl keeps it
    expect(html).toMatch(/sizeSel\.value = v;\s*\r?\n\s*refresh\(\);/);
  });

  it("mirrors filter state into the URL on every successful refresh", async () => {
    const html = await page(await boot());
    expect(html).toContain("function syncUrl()");
    expect(html).toContain('history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));');
    // refresh() syncs after a successful fetch (failure leaves the URL alone)
    expect(html).toMatch(/markLive\(true\);\s*\r?\n\s*syncUrl\(\);/);
  });

  it("clears the querystring on Clear filters even while a poll is in flight", async () => {
    const html = await page(await boot());
    expect(html).toMatch(/syncUrl\(\);\s*\r?\n\s*refresh\(\);/);
  });

  it("keeps default state out of the shared URL", async () => {
    const html = await page(await boot());
    // sort=found is the default and must not be written; empty selects and an
    // empty q are omitted, so an all-defaults view gets a clean URL
    expect(html).toContain('if (v && !(id === "sort" && v === "found")) sp.set(id, v);');
    expect(html).toContain('if (q) sp.set("q", q);');
  });
});
