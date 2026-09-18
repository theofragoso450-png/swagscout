import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { dueSlot, isDue, digestTick, jstFields } from "../src/notify/digest.js";
import type { EmbedPayload } from "../src/notify/embeds.js";
import type { Deal } from "../src/types.js";

const HOUR = 3_600_000;

// 08:00 JST === 23:00 UTC (previous UTC day). Careful with calendars:
// 2026-09-18T23:00Z is 08:00 JST on the JST-calendar day 2026-09-19.
const T_BEFORE = Date.parse("2026-09-18T22:59:00Z"); // 07:59 JST Sep 19
const T_SLOT = Date.parse("2026-09-18T23:00:00Z"); // 08:00 JST Sep 19
const T_AFTER = Date.parse("2026-09-18T23:30:00Z"); // 08:30 JST Sep 19
const T_NEXTDAY = Date.parse("2026-09-19T15:00:00Z"); // 00:00 JST Sep 20

function compDeal(
  id: string,
  discount: number,
  sample: number,
  median: number,
  foundAt: string = new Date(Date.now() - HOUR).toISOString(),
): Deal {
  return {
    listing: {
      id,
      market: "yahoo",
      title: `Yohji coat ${id}`,
      brandKey: "yohji",
      price: 100,
      currency: "USD",
      priceUsd: 100,
      url: `https://auctions.yahoo.co.jp/jp/auction/${id}`,
      foundAt,
    },
    proxy: {},
    reasons: [
      {
        kind: "comp",
        detail: `${discount}% below ${sample}-listing median ($${median.toFixed(0)})`,
      },
    ],
    score: 40,
  };
}

describe("JST slot math", () => {
  it("maps 08:00 JST to 23:00 UTC of the previous UTC day", () => {
    const { instant, day } = dueSlot(T_AFTER);
    expect(instant).toBe(T_SLOT);
    expect(day).toBe("2026-09-19"); // the JST-calendar day
    expect(jstFields(T_AFTER)).toEqual({ day: "2026-09-19", hour: 8, minute: 30 });
  });

  it("isDue false before the slot, true from the slot onward", () => {
    expect(isDue(T_BEFORE)).toBe(false);
    expect(isDue(T_SLOT)).toBe(true);
    expect(isDue(T_AFTER)).toBe(true);
  });

  it("next JST day gets its own slot", () => {
    expect(dueSlot(T_NEXTDAY).instant).toBe(T_SLOT + 86_400_000);
  });

  it("honors a custom hour", () => {
    expect(dueSlot(T_AFTER, 9).instant).toBe(T_SLOT + HOUR);
  });
});

describe("digestTick", () => {
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dbPath = path.join(mkdtempSync(path.join(tmpdir(), "digest-")), "test.db");
    store = new Store(dbPath);
  });

  afterEach(() => {
    store.close();
    rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("not due before the slot — no send, no meta", async () => {
    let calls = 0;
    const r = await digestTick(T_BEFORE, store, async () => {
      calls++;
      return ["c1"];
    });
    expect(r).toEqual({ triggered: false, sentTo: [], findCount: 0 });
    expect(calls).toBe(0);
    expect(store.getMeta("digest:lastSent")).toBeUndefined();
  });

  it("sends once at the slot with ranked finds; idempotent on re-tick", async () => {
    // seed the store so rankFinds has comp-backed deals to rank
    const d = compDeal("d1", 60, 40, 300);
    store.upsertListing(d.listing);
    store.recordDeal({ listing: d.listing, proxy: {}, reasons: d.reasons, score: 40 });
    store.addSubscription({ guildId: "g", channelId: "c1", watch: "all", minScore: 0 });

    const sent: Array<{ embeds: EmbedPayload[]; channels: string[] }> = [];
    const r1 = await digestTick(T_SLOT, store, async (embeds, channels) => {
      sent.push({ embeds, channels });
      return channels;
    });
    expect(r1.triggered).toBe(true);
    expect(r1.findCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.embeds[0]!.fields[0]).toMatchObject({ name: "Find", value: "#1 · A-tier" });
    expect(store.getMeta("digest:lastSent")).toBe(String(T_SLOT));

    // re-tick the same slot: dedupe, no second send
    let calls = 0;
    const r2 = await digestTick(T_AFTER, store, async () => {
      calls++;
      return ["c1"];
    });
    expect(r2.triggered).toBe(false);
    expect(calls).toBe(0);
  });

  it("catch-up: a boot late in the JST day still delivers that morning's digest", async () => {
    // T_LATE = 23:00 JST Sep 19 — eleven hours after the 08:00 slot, same day
    const T_LATE = Date.parse("2026-09-19T14:00:00Z");
    const r = await digestTick(T_LATE, store, async (embeds, channels) => channels);
    expect(r.triggered).toBe(true); // empty finds/channels still mark the slot
    expect(store.getMeta("digest:lastDay")).toBe("2026-09-19");
    expect(store.getMeta("digest:lastSent")).toBe(String(T_SLOT));
  });

  it("no eligible channels → nothing sent but slot marked done", async () => {
    const r = await digestTick(T_SLOT, store, async (_e, channels) => channels);
    expect(r.triggered).toBe(true);
    expect(r.findCount).toBe(0);
    expect(r.sentTo).toEqual([]);
    expect(store.getMeta("digest:lastSent")).toBe(String(T_SLOT));
  });

  it("send failure does NOT mark the slot — next tick retries", async () => {
    const l = compDeal("d2", 50, 20, 200).listing;
    store.upsertListing(l);
    store.recordDeal({ listing: l, proxy: {}, reasons: compDeal("d2", 50, 20, 200).reasons, score: 40 });
    store.addSubscription({ guildId: "g", channelId: "c1", watch: "all", minScore: 0 });

    let attempts = 0;
    const r1 = await digestTick(T_SLOT, store, async () => {
      attempts++;
      return []; // everything failed
    });
    expect(r1.triggered).toBe(false);
    expect(attempts).toBe(1);
    expect(store.getMeta("digest:lastSent")).toBeUndefined();

    // recovery on the next tick
    const r2 = await digestTick(T_AFTER, store, async (_e, channels) => {
      attempts++;
      return channels;
    });
    expect(r2.triggered).toBe(true);
    expect(attempts).toBe(2);
  });
});
