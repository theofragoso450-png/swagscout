import { describe, expect, it } from "vitest";
import { formatUsd } from "../src/core/money.js";

/**
 * The policy in one table: exact to the cent, cents dropped only when they are
 * zero. Card labels, reason lines and Discord embeds all render through this,
 * so a case here is a promise to every surface at once.
 */
describe("formatUsd", () => {
  it("prints the amount exactly, at two decimals", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.26)).toBe("$0.26");
    expect(formatUsd(1.23)).toBe("$1.23");
    expect(formatUsd(19.7)).toBe("$19.70");
    expect(formatUsd(88.46)).toBe("$88.46");
    expect(formatUsd(171.82)).toBe("$171.82");
  });

  it("drops the cents only when there are none", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(12)).toBe("$12");
    expect(formatUsd(180)).toBe("$180");
    expect(formatUsd(1234)).toBe("$1234");
  });

  it("never collapses two different amounts into one string", () => {
    const amounts = [0.01, 0.26, 1.23, 12.77, 13, 19.7, 88.46, 171.82];
    const printed = amounts.map(formatUsd);
    expect(new Set(printed).size).toBe(amounts.length);
  });
});
