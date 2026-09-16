import { describe, expect, it } from "vitest";
import { fetchThumb, isAllowedImageUrl } from "../src/web/thumbs.js";

describe("isAllowedImageUrl", () => {
  it("allows the exact image-CDN hosts of supported markets", () => {
    expect(isAllowedImageUrl("https://auc-pctr.c.yimg.jp/i/auctions.c.yimg.jp/x.jpg")).toBe(true);
    expect(isAllowedImageUrl("https://static.mercdn.net/item/detail/123.png")).toBe(true);
    expect(isAllowedImageUrl("https://asset.fril.jp/img/abc.jpg")).toBe(true);
    expect(isAllowedImageUrl("https://process.grailed.com/a.png")).toBe(true);
    expect(isAllowedImageUrl("https://i.ebayimg.com/images/g/abc/s-l500.jpg")).toBe(true);
  });

  it("rejects non-https schemes even for allowed hosts", () => {
    expect(isAllowedImageUrl("http://static.mercdn.net/a.png")).toBe(false);
    expect(isAllowedImageUrl("ftp://static.mercdn.net/a.png")).toBe(false);
    expect(isAllowedImageUrl("file://static.mercdn.net/a.png")).toBe(false);
  });

  it("rejects hosts that merely contain or suffix an allowed host", () => {
    expect(isAllowedImageUrl("https://static.mercdn.net.evil.example/a.png")).toBe(false);
    expect(isAllowedImageUrl("https://evil-static.mercdn.net/a.png")).toBe(false);
    expect(isAllowedImageUrl("https://static.mercdn.net2/a.png")).toBe(false);
    expect(isAllowedImageUrl("https://yimg.jp/a.png")).toBe(false);
  });

  it("rejects embedded userinfo outright", () => {
    expect(isAllowedImageUrl("https://user@static.mercdn.net/a.png")).toBe(false);
    expect(isAllowedImageUrl("https://user:pass@static.mercdn.net/a.png")).toBe(false);
    expect(isAllowedImageUrl("https://static.mercdn.net@evil.example/a.png")).toBe(false);
  });

  it("rejects garbage and empty input", () => {
    expect(isAllowedImageUrl("")).toBe(false);
    expect(isAllowedImageUrl("not a url")).toBe(false);
    expect(isAllowedImageUrl("///")).toBe(false);
  });
});

describe("fetchThumb", () => {
  it("refuses disallowed hosts before any network I/O", async () => {
    await expect(fetchThumb("http://127.0.0.1:9/x.png")).rejects.toThrow("not allowed");
    await expect(fetchThumb("https://evil.example/a.png")).rejects.toThrow("not allowed");
  });
});
