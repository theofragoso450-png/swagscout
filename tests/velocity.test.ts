import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { startDashboard, type DashboardServer } from "../src/web/server.js";
import { velocityReply } from "../src/notify/discord.js";

/**
 * v0.5.0 unit 4: /velocity — gone-within-48h rate over a brand's last 20
 * sightings. Exit gate (ROADMAP): the command's numbers match a direct SQL
 * read of the store for three brands, and the dashboard section renders the
 * same numbers. Honest labels throughout: "gone" is absence from complete
 * poll rounds, never proof of sale.
 */

let dbPath: string;
let store: Store;

beforeEach(() => {
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "swagscout-vel-")), "test.db");
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

const HOUR = 3_600_000;

let seq = 0;
/** One sighting of `brand` found `hoursAgo` ago; absent since found+`goneInH` if given. */
function sighting(brand: string, hoursAgo: number, goneInH?: number): void {
  const l = normalizeListing({
    market: "yahoo",
    id: `v${seq++}`,
    title: `${brand} tee ${seq}`,
    price: 1000,
    currency: "JPY",
    url: `https://auctions.yahoo.co.jp/jp/auction/v${seq}`,
  });
  l.brandKey = brand;
  // normalizeListing stamps foundAt = now; backdate on the returned object.
  l.foundAt = new Date(Date.now() - hoursAgo * HOUR).toISOString();
  store.upsertListing(l);
  if (goneInH !== undefined) {
    store.applyAbsences(
      "yahoo",
      new Date(Date.now() - hoursAgo * HOUR + goneInH * HOUR).toISOString(),
      [`yahoo:${l.id}`],
    );
  }
}

describe("brandVelocity", () => {
  it("counts vanishings within 48h of sighting over the last n observations", () => {
    // raf: 3 gone ≤48h, 1 gone at 72h (excluded from numerator), 1 live.
    sighting("raf", 100, 10);
    sighting("raf", 90, 12);
    sighting("raf", 80, 47);
    sighting("raf", 200, 72); // vanished, but after the 48h window
    sighting("raf", 10); // still listed
    const s = store.brandVelocity("raf", 20);
    expect(s).toEqual({ observed: 5, gone: 4, goneWithin48h: 3, rate: 3 / 5 });
  });

  it("caps at n observations and ignores corrupt negative lifetimes", () => {
    // The 5 quick vanishings are the OLDEST sightings — the last-20 window
    // must exclude them (i ≥ 20 sorts out of `ORDER BY foundAt DESC LIMIT 20`).
    for (let i = 0; i < 25; i++) sighting("kapital", i * 2 + 2, i >= 20 ? 5 : undefined);
    const s = store.brandVelocity("kapital", 20);
    expect(s.observed).toBe(20); // only the last 20 sightings
    expect(s.goneWithin48h).toBe(0); // the 5 quick vanishings fell outside the window
    // A missingSince BEFORE foundAt is corrupt data, not instant churn.
    const l = normalizeListing({
      market: "yahoo",
      id: "corrupt1",
      title: "yohji corrupt row",
      price: 1000,
      currency: "JPY",
      url: "https://auctions.yahoo.co.jp/jp/auction/corrupt1",
    });
    l.brandKey = "yohji";
    l.foundAt = new Date(Date.now() - 10 * HOUR).toISOString();
    store.upsertListing(l);
    store.applyAbsences("yahoo", new Date(Date.now() - 20 * HOUR).toISOString(), ["yahoo:corrupt1"]);
    const y = store.brandVelocity("yohji", 20);
    expect(y.gone).toBe(1); // counted as absent…
    expect(y.goneWithin48h).toBe(0); // …but the negative lifetime earns no numerator
  });

  it("brandVelocityAll agrees with brandVelocity for every brand", () => {
    sighting("raf", 50, 8);
    sighting("raf", 40, 60);
    sighting("cdg", 30);
    sighting("yohji", 20, 2);
    const all = store.brandVelocityAll(20);
    for (const [key, stat] of all) expect(store.brandVelocity(key, 20)).toEqual(stat);
    expect(all.get("raf")?.goneWithin48h).toBe(1);
    expect(all.get("cdg")?.observed).toBe(1);
    expect(all.get("yohji")?.rate).toBe(1);
  });
});

describe("velocityReply (exit gate: matches a direct SQL read)", () => {
  it("matches an independent SQL computation for three brands", () => {
    sighting("raf", 100, 10);
    sighting("raf", 90, 12);
    sighting("raf", 80, 47);
    sighting("raf", 200, 72);
    sighting("raf", 10);
    sighting("cdg", 30);
    sighting("cdg", 25);
    sighting("yohji", 20, 2);

    // Independent read: raw SQL over the same store, rule re-derived in the
    // test (NOT via brandVelocity/velocityStat).
    const sqlStat = (brand: string) => {
      const rows = store.db
        .prepare(
          `SELECT foundAt, missingSince FROM listings
           WHERE brandKey = ? ORDER BY foundAt DESC, rowid DESC LIMIT 20`,
        )
        .all(brand) as Array<{ foundAt: string; missingSince: string | null }>;
      let within = 0;
      for (const r of rows) {
        if (!r.missingSince) continue;
        const dt = Date.parse(r.missingSince) - Date.parse(r.foundAt);
        if (dt >= 0 && dt <= 48 * HOUR) within++;
      }
      return `${within}/${rows.length} vanished within 48h of being found`;
    };

    for (const brand of ["raf", "cdg", "yohji"]) {
      const reply = velocityReply(store, brand);
      expect(reply).toContain(sqlStat(brand));
    }
    expect(velocityReply(store, "raf")).toContain("**60%**"); // 3/5
  });

  it("stays honest on unknown brands and empty history", () => {
    expect(velocityReply(store, "notabrand")).toContain("not a catalog brand");
    expect(velocityReply(store, "raf")).toContain("no sightings stored yet");
    sighting("raf", 5, 2); // found 5h ago, vanished 2h later — within 48h
    expect(velocityReply(store, "raf")).toContain("absence is not proof of sale");
    expect(velocityReply(store, "raf")).toContain("1/1 vanished within 48h");
  });
});

describe("GET /api/velocity", () => {
  let server: DashboardServer | undefined;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
  });

  it("renders the same numbers the command computes, sorted by rate", async () => {
    sighting("raf", 50, 8);
    sighting("raf", 40, 60);
    sighting("cdg", 30);
    sighting("yohji", 20, 2);
    server = startDashboard(store, 0, () => "test");
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/velocity`);
    const json = (await res.json()) as {
      brands: Array<{ key: string; name: string; observed: number; goneWithin48h: number; rate: number }>;
    };
    expect(json.brands.map((b) => b.key)).toEqual(["yohji", "raf", "cdg"]); // rate desc
    expect(json.brands[0]).toMatchObject({
      key: "yohji",
      observed: 1,
      goneWithin48h: 1,
      rate: 1,
    });
    expect(json.brands[2]).toMatchObject({ key: "cdg", observed: 1, goneWithin48h: 0, rate: 0 });
    // Same stat the command would print:
    const raf = store.brandVelocity("raf", 20);
    expect(json.brands[1]).toMatchObject({ observed: raf.observed, goneWithin48h: raf.goneWithin48h });
  });
});
