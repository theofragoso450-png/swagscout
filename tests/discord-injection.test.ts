import { describe, expect, it } from "vitest";
import { normalizeListing } from "../src/core/normalize.js";
import { proxyLinks } from "../src/proxy/links.js";
import { buildDealEmbed, type EmbedPayload } from "../src/notify/embeds.js";
import type { Deal, Listing } from "../src/types.js";

function listing(
  overrides: Partial<Listing> & { id: string; url: string; market?: Listing["market"] },
): Listing {
  return normalizeListing({
    market: "yahoo",
    title: "normal title",
    price: 1000,
    currency: "JPY",
    ...overrides,
  });
}

function dealFor(l: Listing): Deal {
  return {
    listing: l,
    proxy: proxyLinks(l),
    reasons: [{ kind: "threshold", detail: "test reason" }],
    score: 50,
  };
}

const embedOf = (l: Listing): EmbedPayload => buildDealEmbed(dealFor(l));

describe("Discord embed injection hardening", () => {
  it("omits embed.url for a javascript: listing url (API 400 guard)", () => {
    const e = embedOf(listing({ id: "n1", url: 'javascript:alert("xss")' }));
    expect(e.url).toBeUndefined();
  });

  it("omits embed.url for a data: listing url", () => {
    const e = embedOf(listing({ id: "n2", url: "data:text/html,<script>x</script>" }));
    expect(e.url).toBeUndefined();
  });

  it("omits thumbnail.url for a javascript: image url", () => {
    const l = listing({ id: "n3", url: "https://auctions.yahoo.co.jp/jp/auction/n3" });
    l.imageUrl = "javascript:alert(1)";
    const e = embedOf(l);
    expect(e.thumbnail).toBeUndefined();
  });

  it("keeps https urls on embed and thumbnail", () => {
    const l = listing({ id: "n4", url: "https://auctions.yahoo.co.jp/jp/auction/n4" });
    l.imageUrl = "https://auc-pctr.c.yimg.jp/x.jpg";
    const e = embedOf(l);
    expect(e.url).toBe("https://auctions.yahoo.co.jp/jp/auction/n4");
    expect(e.thumbnail!.url).toBe("https://auc-pctr.c.yimg.jp/x.jpg");
  });

  it("neuters markdown in a hostile size (no link, no breakout)", () => {
    const l = listing({ id: "n5", url: "https://auctions.yahoo.co.jp/jp/auction/n5" });
    l.size = '**[BUY NOW](https://evil.phish "click")**';
    const e = embedOf(l);
    const size = e.fields.find((f) => f.name === "Size")!.value;
    expect(size).not.toContain("[BUY NOW]");
    expect(size).not.toContain("](https://evil.phish");
    expect(size).toContain("BUY NOW"); // text survives, inert
    expect(size).toContain("\\[");
  });

  it("strips line breaks from a hostile size so nothing fakes extra lines", () => {
    const l = listing({ id: "n6", url: "https://auctions.yahoo.co.jp/jp/auction/n6" });
    l.size = "M\n**Price: $1**";
    const e = embedOf(l);
    const size = e.fields.find((f) => f.name === "Size")!.value;
    expect(size).not.toContain("\n");
    expect(size).toContain("M");
  });

  it("caps oversized marketplace size strings below the Discord field limit", () => {
    const l = listing({ id: "n7", url: "https://auctions.yahoo.co.jp/jp/auction/n7" });
    l.size = "M".repeat(3000);
    const e = embedOf(l);
    const size = e.fields.find((f) => f.name === "Size")!.value;
    expect(size.length).toBeLessThanOrEqual(1024);
    expect(size.endsWith("…")).toBe(true);
  });

  it("escapes markdown in marketplace-controlled brandRaw fallback", () => {
    const l = listing({ id: "n8", url: "https://auctions.yahoo.co.jp/jp/auction/n8" });
    l.brandRaw = "**[phish](https://evil.phish)**";
    const e = embedOf(l);
    const brand = e.fields.find((f) => f.name === "Brand")!.value;
    expect(brand).not.toContain("[phish](https://evil.phish)");
    expect(brand).toContain("\\[phish\\]");
  });

  it("derives no proxy links from a hostile mercari id (id charset guard)", () => {
    const p = proxyLinks(
      listing({ market: "mercari", id: "123)](https://evil.phish)", url: "https://www.mercari.com/x" }),
    );
    expect(p).toEqual({});
  });

  it("derives no proxy links from a hostile rakuma id", () => {
    const p = proxyLinks(
      listing({ market: "rakuma", id: "abc](https://evil.phish)", url: "https://item.fril.jp/abc" }),
    );
    expect(p).toEqual({});
  });

  it("still derives proxy links from clean mercari ids (guard is not over-broad)", () => {
    const p = proxyLinks(
      listing({ market: "mercari", id: "m12345678901", url: "https://www.mercari.com/item/m12345678901" }),
    );
    expect(p.buyee).toBe("https://buyee.jp/mercari/purchase/m12345678901");
  });

  it("yahoo proxy ids stay safe: derived from the URL regex capture, not the raw id", () => {
    const p = proxyLinks(
      listing({ id: "hostile ](id)", url: "https://auctions.yahoo.co.jp/jp/auction/n123456789" }),
    );
    expect(p.buyee).toBe("https://buyee.jp/item/yahoo/auction/n123456789");
  });
});
