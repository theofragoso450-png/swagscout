import { describe, expect, it } from "vitest";
import { parseProxyEnv } from "../src/core/browser.js";

/**
 * BROWSER_PROXY parsing: residential proxies are almost always authenticated,
 * and Playwright wants credentials in dedicated username/password fields —
 * embedded-in-server form silently fails proxy auth. These tests pin the
 * split, the decoding, and the pass-through fallbacks.
 */
describe("parseProxyEnv", () => {
  it("returns undefined for unset or blank values", () => {
    expect(parseProxyEnv(undefined)).toBeUndefined();
    expect(parseProxyEnv("")).toBeUndefined();
    expect(parseProxyEnv("   ")).toBeUndefined();
  });

  it("splits embedded credentials into username/password fields", () => {
    expect(parseProxyEnv("http://alice:s3cret@proxy.example.com:8080")).toEqual({
      server: "http://proxy.example.com:8080",
      username: "alice",
      password: "s3cret",
    });
  });

  it("omits credential fields when the URL has none", () => {
    expect(parseProxyEnv("http://proxy.example.com:8080")).toEqual({
      server: "http://proxy.example.com:8080",
    });
  });

  it("percent-decodes credentials", () => {
    expect(parseProxyEnv("http://p%40user:p%40ss@10.0.0.1:3128")).toEqual({
      server: "http://10.0.0.1:3128",
      username: "p@user",
      password: "p@ss",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(parseProxyEnv("  http://u:p@host:9  ")).toEqual({
      server: "http://host:9",
      username: "u",
      password: "p",
    });
  });

  it("passes unparseable values through untouched so the launcher reports them", () => {
    expect(parseProxyEnv("not a url at all")).toEqual({ server: "not a url at all" });
  });

  it("passes scheme-less host:port through (no bogus protocol rewrite)", () => {
    expect(parseProxyEnv("1.2.3.4:8080")).toEqual({ server: "1.2.3.4:8080" });
  });
});
