import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { MercariAdapter } from "../src/markets/mercari.js";
import { HttpClient } from "../src/core/http.js";

const adapter = new MercariAdapter(new HttpClient(600));

describe("MercariAdapter.parseHtml", () => {
  it("parses item cells from search HTML", () => {
    const html = readFileSync("tests/fixtures/mercari_search.html", "utf8");
    const listings = adapter.parseHtml(html);
    expect(listings.length).toBeGreaterThanOrEqual(2);

    const ids = listings.map((l) => l.id);
    expect(ids).toContain("m12345678901");
    expect(ids).toContain("m99887766554");

    const cdg = listings.find((l) => l.id === "m12345678901")!;
    expect(cdg.title).toContain("コムデギャルソン");
    expect(cdg.price).toBe(5500);
    expect(cdg.currency).toBe("JPY");
    expect(cdg.brandKey).toBe("cdg");
    expect(cdg.url).toBe("https://jp.mercari.com/item/m12345678901");
  });

  it("skips rows without a parsable price", () => {
    const html = `<ul>
      <li data-testid="item-cell"><a href="/items/m11111111111">
        <div data-testid="thumbnail-item-name">ナンバーナイン パーカー</div>
      </a></li>
    </ul>`;
    const listings = adapter.parseHtml(html);
    expect(listings).toHaveLength(0);
  });
});
