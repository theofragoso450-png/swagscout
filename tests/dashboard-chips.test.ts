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
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-chips-")), "test.db");
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

describe("active-filter chips row", () => {
  it("renders the row above the results line, hidden when empty", async () => {
    const html = await page(await boot());
    expect(html).toContain('<div id="chipsRow" class="chips-row"></div>');
    // an empty row must occupy no space
    expect(html).toContain(".chips-row:empty { padding:0; }");
    expect(html.indexOf("chipsRow")).toBeLessThan(html.indexOf('id="results"'));
  });

  it("rebuilds chips from control state on every successful refresh", async () => {
    const html = await page(await boot());
    expect(html).toContain("renderChips();");
    expect(html).toMatch(/syncUrl\(\);\s*\r?\n\s*renderChips\(\);/);
  });

  it("covers every non-default control with a human-readable label, sort included", async () => {
    const html = await page(await boot());
    for (const label of ['"Market: "', '"Brand: "', '"Size: "', '"Condition: "', '"Sort: "', '"Title: "']) {
      expect(html).toContain(label);
    }
    // labels resolve ids to the names the selects display, falling back to
    // the raw value for anything unlisted (e.g. a renamed brand key)
    expect(html).toContain("marketLabel(m)");
    expect(html).toContain("brandLabel(b)");
    expect(html).toContain("conditionLabels[c] || c");
    // sort chips label from the option text and only when non-default
    expect(html).toContain("optionText(document.getElementById(\"sort\"), s)");
    expect(html).toContain('if (s && s !== SORT_DEFAULT)');
    // free text truncates instead of stretching the chip row
    expect(html).toContain("q.length > 24");
  });

  it("removes exactly one control per chip click, resetting sort to its default", async () => {
    const html = await page(await boot());
    // per-chip removal clears the control (sort resets to "found" — it has
    // no empty option), then refreshes (re-rendering chips and the URL)
    expect(html).toMatch(/function removeFilter\(id\) \{\s*\r?\n\s*document\.getElementById\(id\)\.value = id === "sort" \? SORT_DEFAULT : "";\s*\r?\n\s*refresh\(\);/);
    // Clear all reuses clearFilters, so chips and URL reset together
    expect(html).toMatch(/all\.addEventListener\("click", clearFilters\);/);
    // chips are user input: built with DOM APIs, never markup interpolation
    expect(html).toContain("row.textContent = \"\";");
    expect(html).toContain("chip.appendChild(document.createTextNode(label + \" \"));");
    expect(html).not.toMatch(/chipsRow.*innerHTML|innerHTML.*chipsRow/);
  });

  it("gives each removal button an accessible name and a visible focus ring", async () => {
    const html = await page(await boot());
    expect(html).toContain('x.setAttribute("aria-label", "Remove filter " + label);');
    expect(html).toContain(".fchip button:focus-visible, .fclear:focus-visible");
  });
});
