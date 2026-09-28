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
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-polish-")), "test.db");
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

describe("dashboard polish sweep", () => {
  it("drives all horizontal padding from one gutter variable with a mobile override", async () => {
    const html = await page(await boot());
    expect(html).toContain(":root { color-scheme: dark; --gutter: 28px; }");
    // the mobile override must follow the definition it overrides
    expect(html.indexOf("--gutter: 28px")).toBeLessThan(html.indexOf("--gutter: 16px"));
    expect(html).toContain("@media (max-width: 500px) {");
    // the surfaces that were flush against the viewport edge share the gutter
    expect(html).toContain("#finds, #velocity { padding: 0 var(--gutter); }");
    expect(html).toContain(".results { font-size:12px; color:#8b949e; padding:12px var(--gutter) 10px; min-height:16px; }");
  });

  it("offers a skip link as the first tab stop, hidden until focused", async () => {
    const html = await page(await boot());
    expect(html.indexOf('class="skip"')).toBeGreaterThan(-1);
    expect(html.indexOf('class="skip"')).toBeLessThan(html.indexOf("<header>"));
    expect(html).toContain('<a class="skip" href="#feed">Skip to deals</a>');
    expect(html).toContain(".skip { position:absolute; left:-9999px;");
    expect(html).toContain(".skip:focus, .skip:focus-visible { left:8px; top:8px; }");
  });

  it("gives the feed and results line programmatic focus targets", async () => {
    const html = await page(await boot());
    expect(html).toContain('<main id="feed" tabindex="-1">');
    expect(html).toContain('<div id="results" class="results" role="status" aria-live="polite" tabindex="-1"></div>');
    expect(html).toContain(".results:focus { outline:2px solid #3fb950; outline-offset:2px; border-radius:4px; }");
  });

  it("returns focus to the chips row after removal instead of dropping to body", async () => {
    const html = await page(await boot());
    // removal path: the clicked button unmounts, so focus moves to the row first
    expect(html).toContain("const row = document.getElementById(\"chipsRow\");\n    if (row) row.focus();");
    // the row accepts focus programmatically without entering tab order
    expect(html).toContain("row.tabIndex = -1;");
    expect(html).toContain("#chipsRow:focus { outline:none; }");
    // clear-all keeps the same discipline
    expect(html).toMatch(/all\.addEventListener\("click", \(\) => \{\s*\r?\n\s*const row = document\.getElementById\("chipsRow"\);\s*\r?\n\s*if \(row\) row\.focus\(\);\s*\r?\n\s*clearFilters\(\);/);
  });

  it("keeps the initial and velocity empty states consistent with the filtered one", async () => {
    const html = await page(await boot());
    // initial feed empty state carries the same icon treatment as the filtered one
    expect(html).toContain('<main id="feed" tabindex="-1"><div class="empty"><div class="imgph" aria-hidden="true"></div>');
    // velocity empties reuse the finds-empty style via DOM APIs, not blank space
    expect(html).toContain('note.className = "finds-empty";');
    expect(html).toContain("No brand sightings yet — velocity appears after the first poll rounds.");
    // and the refresh path clears the row before appending, so chips never duplicate
    expect(html).toMatch(/row\.textContent = "";\s*\r?\n\s*for \(const v of data\.brands/);
  });
});
