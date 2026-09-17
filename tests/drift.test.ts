import { describe, expect, it } from "vitest";
import { findDrift } from "../src/core/drift.js";

function row(overrides: Partial<Parameters<typeof findDrift>[0][number]> = {}) {
  return {
    key: "yahoo:test1",
    market: "yahoo" as const,
    title: "Yohji Yamamoto POUR HOMME shirt size L",
    brandKey: "yohji",
    size: "L",
    ...overrides,
  };
}

describe("findDrift", () => {
  it("returns empty when stored values match the current matchers", () => {
    expect(findDrift([row()])).toEqual([]);
  });

  it("flags a brand mismatch", () => {
    const drift = findDrift([row({ brandKey: null })]);
    expect(drift).toEqual([
      { key: "yahoo:test1", field: "brandKey", stored: null, computed: "yohji" },
    ]);
  });

  it("flags a size mismatch", () => {
    const drift = findDrift([row({ size: null })]);
    expect(drift).toEqual([
      { key: "yahoo:test1", field: "size", stored: null, computed: "L" },
    ]);
  });

  it("exempts explicit-size markets (Grailed) from the size check", () => {
    // Grailed passes its own size at ingest; a stored size the title
    // extractor would not find is EXPECTED there, not drift.
    const drift = findDrift([
      row({
        key: "grailed:1",
        market: "grailed",
        title: "Rick Owens Geobasket",
        brandKey: "rick-owens",
        size: "US 9",
      }),
    ]);
    expect(drift).toEqual([]);
  });
});
