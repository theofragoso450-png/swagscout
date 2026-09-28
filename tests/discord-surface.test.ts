import { describe, expect, it } from "vitest";
import { brandCatalogPages } from "../src/notify/discord.js";
import { BRANDS } from "../src/config/brands.js";
import { normalizeListing } from "../src/core/normalize.js";
import { proxyLinks } from "../src/proxy/links.js";
import { buildDealEmbed } from "../src/notify/embeds.js";
import type { Deal, Listing } from "../src/types.js";

function dealWithTitle(title: string): Deal {
  const l: Listing = normalizeListing({
    market: "yahoo",
    id: "d1",
    title,
    price: 1000,
    currency: "JPY",
    url: "https://auctions.yahoo.co.jp/jp/auction/d1",
  });
  return { listing: l, proxy: proxyLinks(l), reasons: [{ kind: "threshold", detail: "test reason" }], score: 50 };
}

describe("Discord surface polish", () => {
  it("fits the real catalog on one page today, but pages instead of truncating when it grows", () => {
    const lines = BRANDS.map((b) => `**${b.name}** — \`${b.key}\``);
    const onePage = brandCatalogPages(lines);
    expect(onePage).toHaveLength(1);

    // a synthetic catalog that cannot fit: every line must survive intact on
    // some page (no truncation, no dropped brands), and each page must stay
    // within the escaped-length budget Discord enforces after rendering
    const wide = Array.from({ length: 40 }, (_, i) => `**Brand name number ${i} is deliberately long here** — \`brand-key-${i}\``);
    const pages = brandCatalogPages(wide, 400);
    expect(pages.length).toBeGreaterThan(1);
    const rejoined = pages.map((p) => p.split("\n")).flat();
    expect(rejoined).toEqual(wide);
    const escapedLen = (s: string) => s.replace(/[\\`*_~[\]()<>|]/g, "x").length;
    for (const p of pages) expect(escapedLen(p)).toBeLessThanOrEqual(400);
  });

  it("never lets a marketplace title render as markdown in the embed title", () => {
    const e = buildDealEmbed(dealWithTitle("cdg tee **not bold** _not italic_ [link](x) line1\nline2"));
    // same escaping the fields use: every markdown metacharacter arrives
    // backslash-escaped (so it renders literally), newline flattened
    expect(e.title).toContain("\\*\\*not bold\\*\\*");
    expect(e.title).toContain("\\[link\\]\\(x\\)");
    expect(e.title).not.toMatch(/\n/);
    expect(e.title).toContain("line1 line2");
    expect(e.title.length).toBeLessThanOrEqual(256);
  });

  it("keeps long titles escaped rather than truncating unescaped", () => {
    const long = "cdg **bold** ".repeat(25); // >250 chars, markdown inside
    const e = buildDealEmbed(dealWithTitle(long));
    expect(e.title.length).toBeLessThanOrEqual(256);
    expect(e.title).not.toContain("**");
  });

  it("wires /status to count the whole documented window, not a probe row", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/notify/discord.ts", "utf8");
    // the 1-row probe made "Deal history: available" true regardless of volume
    expect(src).toContain('this.store.recentDeals(["all"], 2000).length');
    expect(src).toContain("💾 Deal history (14d): ${deals} deal");
  });

  it("keeps the digest contract: failed sends retry, empty/no-channel days do not", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/notify/digest.ts", "utf8");
    // join wrapped comment lines so the phrases match regardless of wrapping
    const flat = src.replace(/\r?\n\s*\*\s?/g, " ");
    expect(flat).toContain("A send failure (every channel failed) is retried on later ticks");
    expect(flat).toContain("an empty catalog or a day with no subscribed channels marks the slot");
    // and the behavioral half is pinned in digest.test.ts (retry succeeds;
    // empty/no-channel marks the slot done)
  });
});
