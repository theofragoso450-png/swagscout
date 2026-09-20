import { describe, expect, it } from "vitest";
import * as fx from "../src/core/fx.js";

describe("fx, the MX path", () => {
  it("converts JPY to USD using the static fallback", () => {
    expect(fx.toUsd(1550, "JPY")).toBeCloseTo(10, 4);
    expect(fx.toUsd(3000, "JPY")).toBeCloseTo(19.3548, 4);
  });

  it("does not throw on an unknown currency unless it is truly unknown", () => {
    expect(() => fx.toUsd(100, "EUR")).not.toThrow();
    expect(() => fx.toUsd(100, "JPY")).not.toThrow();
    expect(() => fx.toUsd(100, "BAD")).toThrow(/Unknown currency/);
  });
});

describe("fx arithmetic", () => {
  it("a 3000 JPY deal at a 0.006 JPY/USD rate is $18.00", () => {
    const rate = 0.006;
    const jpyPerUsd = 1 / rate;
    expect(rate * 3000).toBeCloseTo(18, 4);
    expect(jpyPerUsd).toBeCloseTo(166.6667, 4);
  });

  it("1 / 155 on JPY, 1 on USD, 1.08 on EUR, 1.27 on GBP", () => {
    expect(fx.FX_TO_USD.JPY).toBeCloseTo(1 / 155, 6);
    expect(fx.FX_TO_USD.JPY).toBeGreaterThan(0);
    expect(fx.FX_TO_USD.USD).toBe(1);
    expect(fx.FX_TO_USD.EUR).toBe(1.08);
    expect(fx.FX_TO_USD.GBP).toBe(1.27);
  });
});
