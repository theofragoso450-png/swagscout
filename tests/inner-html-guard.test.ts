import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const SERVER_TS = join(SRC_ROOT, "web", "server.ts");

export interface Violation {
  line: number;
  token: string;
}

/**
 * Tokens the scanner may accept without escapeHtml/safeUrl. Each entry is a
 * deliberate, reviewed decision — not an oversight:
 *  - m.id/m.label/b.key/b.name: rendered from our own constant catalogs
 *  - d.priceLabel: server-composed from numbers + fixed currency symbols
 *  - d.score: a number
 *  - reasons: built only from our rule engine's fixed detail strings
 *  - proxies: built in the line above via safeUrl + escapeHtml per link
 */
const ALLOWED_EXACT = new Set([
  "m.id",
  "m.label",
  "b.key",
  "b.name",
  "d.priceLabel",
  "d.score",
  "reasons",
  "proxies",
]);

/**
 * Ternaries whose branches are static markup — their embedded value tokens
 * are scanned (and must pass) separately via the nested-token pass.
 * The !isFind / d.rank guards gate find-section-only markup (rank/tier are
 * server-computed numbers from rankFinds, never marketplace-controlled).
 */
const ALLOWED_PREFIXES = [
  "d.imageUrl ?",
  "d.size ?",
  "d.condition ?",
  "d.endsInMin != null",
  "d.rank != null",
  "!isFind && d.condition ?",
  "!isFind && d.endsInMin != null",
  // missingForLabel: server-composed via fmtDuration from the store's ISO stamp
  "!isFind && d.missingForLabel ?",
  // titleLang: a static-markup ternary (` lang="ja"` / absent) whose embedded
  // value token is escapeHtml(d.titleLang) and is verified by the nested pass
  "d.titleLang ?",
  // fast: a server-computed boolean (brand gone-now share ≥ FAST_MOVER_SHARE)
  // gating purely static badge markup — no interpolated value inside.
  "d.fast ?",
];

export function isUnsafe(token: string): boolean {
  const t = token.trim();
  if (/^(escapeHtml|safeUrl|JSON\.stringify|fmtDur)\s*\(/.test(t)) return false;
  if (ALLOWED_EXACT.has(t)) return false;
  if (ALLOWED_PREFIXES.some((p) => t.startsWith(p))) return false;
  return true;
}

/**
 * Lint-style scan of the dashboard page's client script: every ${...} token
 * that reaches innerHTML must be escapeHtml(...)/safeUrl(...) output, a
 * server-side JSON.stringify injection, or an explicitly allowlisted trusted
 * value. Balanced-brace tokenization so nested tokens (ternaries containing
 * another ${...}) are validated individually. Documented out of scope: non-
 * template string concatenation (none in the render path; style awaits the
 * helpers on every value).
 */
export function findUnsafeInterpolations(content: string): Violation[] {
  const violations: Violation[] = [];
  const start = content.search(/\$\{JSON\.stringify\(/);
  if (start === -1) return violations;
  const htmlEnd = content.indexOf("</html>");
  const window = htmlEnd === -1 ? content.slice(start) : content.slice(start, htmlEnd);

  let i = window.indexOf("${");
  while (i !== -1) {
    let depth = 0;
    let j = i + 2;
    for (; j < window.length; j++) {
      const c = window[j];
      if (c === "{") depth++;
      else if (c === "}") {
        if (depth === 0) break;
        depth--;
      }
    }
    const token = window.slice(i + 2, j);
    if (isUnsafe(token)) {
      const line = content.slice(0, start + i).split(/\r?\n/).length;
      violations.push({ line, token: token.trim().slice(0, 80) });
    }
    i = window.indexOf("${", i + 2); // nested tokens get their own validation pass
  }
  return violations;
}

describe("innerHTML regression guard (dashboard render path)", () => {
  it("every ${...} in web/server.ts's client script is escaped, URL-gated, or explicitly allowlisted", () => {
    const content = readFileSync(SERVER_TS, "utf8");
    const violations = findUnsafeInterpolations(content);
    expect(
      violations,
      `unescaped interpolations in the dashboard render path — wrap marketplace-controlled ` +
        `values in escapeHtml(...) (text/attributes) or safeUrl(...) (URLs), or extend the ` +
        `reviewed allowlist with a comment if the value is server-trusted:\n` +
        violations.map((v) => `  server.ts:${v.line}  \${${v.token}}`).join("\n"),
    ).toEqual([]);
  });

  describe("scanner self-check (the guard must not rot)", () => {
    it("flags raw marketplace-controlled values in HTML positions", () => {
      const bad = [
        "const x = ${JSON.stringify([])};",
        'const h = `<a href="${d.url}">${d.title}</a>`;',
      ].join("\n");
      expect(findUnsafeInterpolations(bad)).toEqual([
        { line: 2, token: "d.url" },
        { line: 2, token: "d.title" },
      ]);
    });

    it("accepts escapeHtml/safeUrl-wrapped values", () => {
      const good = [
        "const x = ${JSON.stringify([])};",
        'const h = `<a href="${escapeHtml(safeUrl(d.url))}">${escapeHtml(d.title)}</a>`;',
      ].join("\n");
      expect(findUnsafeInterpolations(good)).toEqual([]);
    });

    it("honors the exact-token allowlist for reviewed trusted values", () => {
      const good = [
        "const x = ${JSON.stringify([])};",
        "const h = `<span>${d.score}</span><div>${proxies}</div>`;",
      ].join("\n");
      expect(findUnsafeInterpolations(good)).toEqual([]);
    });

    it("validates tokens nested inside ternary markup individually", () => {
      const mixed = [
        "const x = ${JSON.stringify([])};",
        'const h = `${d.size ? `<b>${escapeHtml(d.size)}</b>` : ""}${d.url ? `<i>${d.title}</i>` : ""}`;',
      ].join("\n");
      // first ternary: prefix-allowlisted markup + escaped inner token → pass
      // second ternary: d.url is marketplace-controlled (not an allowlisted
      // prefix), so BOTH the outer ternary and the nested raw d.title flag
      expect(findUnsafeInterpolations(mixed)).toEqual([
        { line: 2, token: 'd.url ? `<i>${d.title}</i>` : ""' },
        { line: 2, token: "d.title" },
      ]);
    });

    it("ignores server-side code after the page template", () => {
      const after = [
        "const x = ${JSON.stringify([])};",
        "</html>",
        "const s = `/api/thumb?u=${encodeURIComponent(u)}`;",
      ].join("\n");
      expect(findUnsafeInterpolations(after)).toEqual([]);
    });
  });
});
