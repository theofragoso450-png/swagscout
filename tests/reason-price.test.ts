import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { startDashboard, type DashboardServer } from "../src/web/server.js";
import { formatReason } from "../src/core/reasons.js";
import { formatUsd } from "../src/core/money.js";
import { buildDealEmbed, type EmbedPayload } from "../src/notify/embeds.js";
import * as fx from "../src/core/fx.js";
import type { DealReason, Listing } from "../src/types.js";

let dbPath: string;
let store: Store;
let server: DashboardServer | undefined;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-reason-")), "test.db");
  store = new Store(dbPath);
  fx.resetFxRates();
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  store.close();
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

function listing(id: string, price: number, currency: "JPY" | "USD" = "JPY"): Listing {
  return normalizeListing({
    market: "yahoo",
    id,
    title: `kapital coat ${id}`,
    price,
    currency,
    url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
  });
}

function seed(l: Listing, reasons: DealReason[]): void {
  store.upsertListing(l);
  store.recordDeal({ listing: l, proxy: {}, reasons, score: 40 });
}

interface WireItem {
  priceLabel: string;
  reasons: Array<{ kind: string; detail: string }>;
}

async function deals(port: number): Promise<WireItem[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/deals`);
  return ((await res.json()) as { deals: WireItem[] }).deals;
}

/** The USD number a card prints, and the one its reason names. */
function usdNumbers(item: WireItem): { card: number; reason: number } {
  const reason = item.reasons[0]!;
  return {
    card: Number(/([\d.]+)\s*$/.exec(item.priceLabel)![1]),
    reason: Number(/price \$([\d.]+)/.exec(reason.detail)![1]),
  };
}

/** The Price field an embed carries, market flag and all. */
function embedPrice(embed: EmbedPayload): string {
  return embed.fields.find((f) => f.name === "Price")!.value;
}

describe("formatReason", () => {
  it("prices every reason kind from the price it is handed", () => {
    expect(formatReason({ kind: "threshold", capUsd: 180, note: "Kapital" }, 103.95)).toBe(
      "price $103.95 ≤ $180 — Kapital",
    );
    expect(formatReason({ kind: "comp", medianUsd: 400, sampleSize: 20 }, 200)).toBe(
      "50% below 20-listing median ($400)",
    );
    expect(formatReason({ kind: "price_drop", wasUsd: 187 }, 171.82)).toBe(
      "dropped from $187 to $171.82",
    );
  });

  it("re-derives a comp's discount, so it cannot outlive the price it describes", () => {
    const comp: DealReason = { kind: "comp", medianUsd: 400, sampleSize: 20 };
    expect(formatReason(comp, 200)).toContain("50% below");
    expect(formatReason(comp, 300)).toContain("25% below");
  });

  it("gives sub-dollar amounts the precision that keeps the line true", () => {
    // A 1-yen start listing is $0.01: rounded, the line read "price $0 ≤ $350"
    // and a median of "$0" beside a percentage computed from the real number.
    expect(formatReason({ kind: "threshold", capUsd: 350, note: "Yohji mainline" }, 0.01)).toBe(
      "price $0.01 ≤ $350 — Yohji mainline",
    );
    expect(formatReason({ kind: "comp", medianUsd: 0.22, sampleSize: 2 }, 0.01)).toBe(
      "95.5% below 2-listing median ($0.22)",
    );
    expect(formatReason({ kind: "price_drop", wasUsd: 1.4 }, 1.23)).toBe(
      "dropped from $1.40 to $1.23",
    );
  });

  it("cannot print a drop whose two numbers read the same", () => {
    // A 23-cent drop, which whole dollars rendered as "from $13 to $13".
    expect(formatReason({ kind: "price_drop", wasUsd: 13 }, 12.77)).toBe(
      "dropped from $13 to $12.77",
    );
    // A single cent apart still reads as a drop, because the cent is printed.
    expect(formatReason({ kind: "price_drop", wasUsd: 12.78 }, 12.77)).toBe(
      "dropped from $12.78 to $12.77",
    );
  });

  it("stands on the recorded text when a reason carries no parameters", () => {
    // Deals stored before reasons were structured — nothing to re-render.
    expect(formatReason({ kind: "threshold", detail: "price $102 ≤ $180 — old" }, 99)).toBe(
      "price $102 ≤ $180 — old",
    );
    expect(formatReason({ kind: "comp" }, 99)).toBe("");
  });

  it("recovers a legacy drop's from-price instead of replaying its stale endpoint", () => {
    // Includes rows old code wrote with a nonsense "to": the one number worth
    // keeping is what it dropped from, and the endpoint is today's price.
    expect(formatReason({ kind: "price_drop", detail: "dropped from $303 to $0" }, 171.82)).toBe(
      "dropped from $303 to $171.82",
    );
    expect(formatReason({ kind: "price_drop", detail: "dropped from $187 to $174" }, 150)).toBe(
      "dropped from $187 to $150",
    );
  });
});

describe("reason prices at read time", () => {
  it("keep the number a reason names equal to the number the card prints", async () => {
    seed(listing("r1", 15_800), [
      { kind: "threshold", capUsd: 180, note: "Kapital" },
    ]);
    server = startDashboard(store, 0, () => "test");
    const port = await server.start();

    const before = usdNumbers((await deals(port))[0]!);
    expect(before.card).toBeCloseTo(15_800 / 155, 1); // 101.94
    expect(before.reason).toBe(before.card); // the same cents, not a rounded one

    // A rate refresh is exactly what used to tear the two apart: the card moved
    // and the stored sentence did not.
    await fx.refreshFxRates(store, async () => ({ base_code: "USD", rates: { USD: 1, JPY: 130 } }));

    const after = usdNumbers((await deals(port))[0]!);
    expect(after.card).toBeCloseTo(15_800 / 130, 1); // 121.54
    expect(after.reason).toBe(after.card);
    expect(after.reason).not.toBe(before.reason); // it followed the rate
  });

  it("does the same for a USD listing, where the card keeps cents", async () => {
    seed(listing("r2", 171.82, "USD"), [{ kind: "price_drop", wasUsd: 187 }]);
    server = startDashboard(store, 0, () => "test");
    const port = await server.start();

    const item = (await deals(port))[0]!;
    expect(item.priceLabel).toBe("$171.82");
    expect(item.reasons[0]!.detail).toBe("dropped from $187 to $171.82");
  });

  it("writes one amount the same way on the card, in the reason and in the embed", async () => {
    const l = listing("r5", 13_700); // ¥13,700 ≈ $88.39 at the static 155
    seed(l, [
      { kind: "threshold", capUsd: 120, note: "CDG basics/mainline" },
      { kind: "price_drop", wasUsd: 95.4 },
    ]);
    server = startDashboard(store, 0, () => "test");
    const port = await server.start();

    const deal = store.recentDeals(["all"], 10)[0]!;
    const printed = formatUsd(deal.listing.priceUsd); // $88.39

    const item = (await deals(port))[0]!;
    expect(item.priceLabel).toBe(printed);
    expect(item.reasons[0]!.detail).toBe(
      `price ${printed} ≤ $120 — CDG basics/mainline`,
    );
    expect(item.reasons[1]!.detail).toBe(`dropped from $95.40 to ${printed}`);
    // The embed adds the native price for a yen listing; the USD amount it names
    // is written exactly as the card writes it.
    expect(embedPrice(buildDealEmbed(deal))).toContain(printed);
  });

  it("prints a sub-dollar listing's line the way the card prints its price", async () => {
    seed(listing("r4", 40), [
      { kind: "threshold", capUsd: 120, note: "CDG basics/mainline" },
      { kind: "comp", medianUsd: 0.22, sampleSize: 2 },
    ]);
    server = startDashboard(store, 0, () => "test");
    const port = await server.start();

    const item = (await deals(port))[0]!;
    const details = item.reasons.map((r) => r.detail);
    expect(details[0]).toBe("price $0.26 ≤ $120 — CDG basics/mainline");
    expect(details[1]).toContain("($0.22)");
    expect(details.join(" ")).not.toMatch(/\$0(?!\.)/);
  });

  it("renders a legacy deal's recorded line rather than inventing parameters", async () => {
    seed(listing("r3", 15_800), [{ kind: "threshold", detail: "price $102 ≤ $180 — old row" }]);
    server = startDashboard(store, 0, () => "test");
    const port = await server.start();

    expect((await deals(port))[0]!.reasons[0]!.detail).toBe("price $102 ≤ $180 — old row");
  });
});
