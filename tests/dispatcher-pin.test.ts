import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));

function walkTs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walkTs(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}

interface ScanFile {
  path: string;
  content: string;
}

export interface Offender {
  path: string;
  line: number;
  reason: "missing dispatcher" | "inline Agent";
}

/**
 * Lint-style scan: every `await request(` in a file that imports undici's
 * request must pass the shared dispatcher within its options block (8 lines),
 * and must not construct its own Agent inline — all dispatchers come from the
 * single root pin in core/http.ts. Documented out of scope: non-awaited
 * request() calls (none exist; the project's style awaits every call).
 */
export function findUnpinnedCallSites(files: ScanFile[]): Offender[] {
  const offenders: Offender[] = [];
  for (const { path, content } of files) {
    const importsUndiciRequest =
      /import\s*\{[^}]*\brequest\b[^}]*\}\s*from\s*["']undici["']/.test(content);
    if (!importsUndiciRequest) continue;
    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/\bawait request\(/.test(line)) return;
      const block = lines.slice(i, i + 8).join("\n");
      if (!block.includes("dispatcher")) {
        offenders.push({ path, line: i + 1, reason: "missing dispatcher" });
      } else if (/new Agent\(/.test(block)) {
        offenders.push({ path, line: i + 1, reason: "inline Agent" });
      }
    });
  }
  return offenders;
}

describe("h1-pin regression guard (undici v8 negotiates h2 by default on TLS)", () => {
  it("every request() call site in src/ passes the shared dispatcher", () => {
    const files = walkTs(SRC_ROOT).map((p) => ({
      path: p,
      content: readFileSync(p, "utf8"),
    }));
    const offenders = findUnpinnedCallSites(files);
    expect(
      offenders,
      `unpinned undici request() call sites — pass the shared dispatcher from core/http.ts:\n` +
        offenders.map((o) => `  ${o.path}:${o.line} (${o.reason})`).join("\n"),
    ).toEqual([]);
  });

  it("the shared dispatcher exists at the root pin with allowH2:false", () => {
    const http = readFileSync(join(SRC_ROOT, "core", "http.ts"), "utf8");
    expect(http).toMatch(/export const dispatcher = new Agent\(\{[^}]*allowH2:\s*false[^}]*\}\)/);
  });

  describe("scanner self-check (the guard must not rot)", () => {
    const undiciImport = `import { request } from "undici";\n`;

    it("flags a call site missing the dispatcher (the ebay.ts defect class)", () => {
      const bad: ScanFile[] = [
        {
          path: "fixture.ts",
          content: `${undiciImport}\nasync function f() {\n  const res = await request("https://x", {\n    method: "POST",\n  });\n}\n`,
        },
      ];
      expect(findUnpinnedCallSites(bad)).toEqual([
        { path: "fixture.ts", line: 4, reason: "missing dispatcher" },
      ]);
    });

    it("flags a call site constructing its own Agent inline", () => {
      const bad: ScanFile[] = [
        {
          path: "fixture.ts",
          content: `${undiciImport}\nconst res = await request(url, {\n  dispatcher: new Agent({ allowH2: true }),\n});\n`,
        },
      ];
      expect(findUnpinnedCallSites(bad)).toEqual([
        { path: "fixture.ts", line: 3, reason: "inline Agent" },
      ]);
    });

    it("accepts a correctly pinned call site", () => {
      const good: ScanFile[] = [
        {
          path: "fixture.ts",
          content: `import { request } from "undici";\nimport { dispatcher } from "./core/http.js";\nconst res = await request(url, {\n  dispatcher,\n});\n`,
        },
      ];
      expect(findUnpinnedCallSites(good)).toEqual([]);
    });

    it("ignores files that do not import undici's request directly", () => {
      const unrelated: ScanFile[] = [
        {
          path: "fixture.ts",
          content: `import { HttpClient } from "./core/http.js";\nconst t = await client.request(url);\n`,
        },
      ];
      expect(findUnpinnedCallSites(unrelated)).toEqual([]);
    });
  });
});
