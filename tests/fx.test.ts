import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
import { normalizeListing } from "../src/core/normalize.js";
import { loadEnv } from "../src/config/env.js";
import * as fx from "../src/core/fx.js";

/** A well-formed API payload: `rates` are units per USD. */
const GOOD_PAYLOAD = {
  result: "success",
  base_code: "USD",
  rates: { USD: 1, JPY: 150, EUR: 0.8, GBP: 0.75 },
};

let dir: string;
let dbPath: string;
let stores: Store[];

function openStore(): Store {
  const store = new Store(dbPath);
  stores.push(store);
  return store;
}

function closeAll(): void {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed by the test */
    }
  }
  stores = [];
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "swagscout-fx-"));
  dbPath = path.join(dir, "test.db");
  stores = [];
  fx.resetFxRates();
});

afterEach(() => {
  closeAll();
  rmSync(dir, { recursive: true, force: true });
});

describe("fx conversion on the built-in table", () => {
  it("converts JPY to USD at the static rate", () => {
    expect(fx.toUsd(1550, "JPY")).toBeCloseTo(10, 4);
    expect(fx.toUsd(3000, "JPY")).toBeCloseTo(19.3548, 4);
  });

  it("is case-insensitive and throws only on a currency it cannot know", () => {
    expect(fx.toUsd(100, "jpy")).toBeCloseTo(100 / 155, 6);
    expect(() => fx.toUsd(100, "EUR")).not.toThrow();
    expect(() => fx.toUsd(100, "BAD")).toThrow(/Unknown currency/);
  });

  it("starts on the static table with nothing cached", () => {
    expect(fx.fxSourceName()).toBe("static");
    expect(fx.currentFxRates().JPY).toBeCloseTo(1 / 155, 8);
  });
});

describe("parseFxRates rejects payloads that would corrupt state", () => {
  it("inverts units-per-USD into USD-per-unit", () => {
    expect(fx.parseFxRates(GOOD_PAYLOAD)).toEqual({ USD: 1, JPY: 1 / 150, EUR: 1.25, GBP: 1 / 0.75 });
  });

  it("rejects a partial set — a missing JPY would break every yen listing", () => {
    const { JPY: _dropped, ...withoutYen } = GOOD_PAYLOAD.rates;
    expect(fx.parseFxRates({ rates: withoutYen })).toBeNull();
  });

  it("accepts a payload that only carries the currencies we actually convert", () => {
    expect(fx.parseFxRates({ rates: { USD: 1, JPY: 150 } })).toEqual({ USD: 1, JPY: 1 / 150 });
  });

  it.each(["EUR", "GBP"])(
    "lets a missing or bad %s through instead of sinking the payload",
    (code) => {
      const { [code as "EUR" | "GBP"]: _gone, ...without } = GOOD_PAYLOAD.rates;
      const dropped = fx.parseFxRates({ rates: without });
      expect(dropped).not.toBeNull();
      expect(dropped!.JPY).toBeCloseTo(1 / 150, 8);
      expect(dropped![code]).toBeUndefined(); // absent, and not fatal

      const bad = fx.parseFxRates({ rates: { ...GOOD_PAYLOAD.rates, [code]: -1 } });
      expect(bad).not.toBeNull();
      expect(bad!.JPY).toBeCloseTo(1 / 150, 8);
      expect(bad![code]).toBeUndefined();
    },
  );

  it.each([
    ["zero", 0],
    ["negative", -12],
    ["non-numeric", "150"],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s rate", (_label, bad) => {
    expect(fx.parseFxRates({ rates: { ...GOOD_PAYLOAD.rates, JPY: bad } })).toBeNull();
  });

  it.each([
    ["a non-object payload", "nope"],
    ["null", null],
    ["a payload without rates", { result: "success" }],
    ["a null rates map", { rates: null }],
    ["an array as rates", { rates: [1, 2] }],
    ["an error payload", { result: "error", "error-type": "unsupported-code" }],
  ])("rejects %s", (_label, payload) => {
    expect(fx.parseFxRates(payload)).toBeNull();
  });
});

describe("resolution order: live → cached snapshot → static table", () => {
  it("a successful refresh goes live and persists the snapshot", async () => {
    const store = openStore();
    const res = await fx.refreshFxRates(store, async () => GOOD_PAYLOAD);

    expect(res).toEqual({ ok: true, source: "live" });
    expect(fx.fxSourceName()).toBe("live");
    expect(fx.toUsd(150, "JPY")).toBeCloseTo(1, 8); // 150 JPY = $1 at the live rate
    expect(store.getMeta(fx.FX_SNAPSHOT_KEY)).toBeDefined();
    expect(store.getMeta(fx.FX_FETCHED_AT_KEY)).toBeDefined();
  });

  it("a later boot restores the snapshot as cached, without a fetch", async () => {
    const first = openStore();
    await fx.refreshFxRates(first, async () => GOOD_PAYLOAD);
    first.close();

    fx.resetFxRates(); // a fresh process starts on the static table
    expect(fx.fxSourceName()).toBe("static");

    const second = openStore();
    let calls = 0;
    const res = await fx.bootFxRefresh(second, {
      hours: 24,
      fetchJson: async () => {
        calls++;
        return GOOD_PAYLOAD;
      },
      now: () => Date.now(), // the snapshot is fresh, so the fetch is skipped
    });

    expect(calls).toBe(0);
    expect(res.source).toBe("cached");
    expect(fx.toUsd(150, "JPY")).toBeCloseTo(1, 8);
  });

  it("a failed fetch keeps serving the cached snapshot rather than degrading", async () => {
    const store = openStore();
    await fx.refreshFxRates(store, async () => GOOD_PAYLOAD);
    store.close();

    fx.resetFxRates();
    const reopened = openStore();
    expect(fx.restoreFxRates(reopened)).toBe(true);

    const res = await fx.refreshFxRates(reopened, async () => {
      throw new Error("network down");
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fetch failed");
    expect(fx.fxSourceName()).toBe("cached");
    expect(fx.toUsd(150, "JPY")).toBeCloseTo(1, 8); // still the cached rate
  });

  it("a failed fetch on a database that never cached keeps the static table serving", async () => {
    const store = openStore();
    const res = await fx.refreshFxRates(store, async () => {
      throw new Error("network down");
    });

    expect(res.ok).toBe(false);
    expect(fx.fxSourceName()).toBe("static");
    expect(fx.toUsd(155, "JPY")).toBeCloseTo(1, 8);
  });

  it("an invalid payload is rejected and leaves the good rates in force", async () => {
    const store = openStore();
    await fx.refreshFxRates(store, async () => GOOD_PAYLOAD);

    const res = await fx.refreshFxRates(store, async () => ({
      rates: { USD: 1, JPY: -5, EUR: 0.8, GBP: 0.75 },
    }));

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid payload");
    expect(fx.fxSourceName()).toBe("live"); // unchanged
    expect(fx.toUsd(150, "JPY")).toBeCloseTo(1, 8); // not half-updated
  });
});

describe("degraded stores", () => {
  it("a fresh database with no snapshot falls back to the static table", () => {
    const store = openStore();
    expect(fx.restoreFxRates(store)).toBe(false);
    expect(fx.fxSourceName()).toBe("static");
  });

  it("an unreadable snapshot is ignored", () => {
    const store = openStore();
    store.setMeta(fx.FX_SNAPSHOT_KEY, "{not json");
    expect(fx.restoreFxRates(store)).toBe(false);
    expect(fx.fxSourceName()).toBe("static");

    store.setMeta(fx.FX_SNAPSHOT_KEY, JSON.stringify({ rates: { USD: 1 } }));
    expect(fx.restoreFxRates(store)).toBe(false); // valid JSON, unusable payload
    expect(fx.fxSourceName()).toBe("static");
  });

  it("an unwritable store falls back to static instead of throwing", () => {
    const broken = {
      getMeta: () => {
        throw new Error("database is locked");
      },
    } as unknown as Store;

    expect(fx.restoreFxRates(broken)).toBe(false);
    expect(fx.fxSourceName()).toBe("static");
    expect(fx.toUsd(155, "JPY")).toBeCloseTo(1, 8);
  });

  it("a store that cannot persist still serves the fetched rates this process", async () => {
    const broken = {
      setMeta: () => {
        throw new Error("attempt to write a readonly database");
      },
    } as unknown as Store;

    const res = await fx.refreshFxRates(broken, async () => GOOD_PAYLOAD);

    expect(res.ok).toBe(true);
    expect(fx.fxSourceName()).toBe("live");
    expect(fx.toUsd(150, "JPY")).toBeCloseTo(1, 8);
  });
});

describe("refresh cadence", () => {
  it("never refreshes when the cadence is 0", async () => {
    const store = openStore();
    store.setMeta(fx.FX_FETCHED_AT_KEY, new Date(0).toISOString());
    expect(fx.fxRefreshDue(store, 0)).toBe(false);

    let calls = 0;
    const res = await fx.bootFxRefresh(store, {
      hours: 0,
      fetchJson: async () => {
        calls++;
        return GOOD_PAYLOAD;
      },
    });
    expect(calls).toBe(0);
    expect(res.source).toBe("static");
  });

  it("is due when nothing has ever been fetched, and once the window elapses", () => {
    const store = openStore();
    const now = Date.parse("2026-09-20T00:00:00.000Z");
    expect(fx.fxRefreshDue(store, 24, now)).toBe(true);

    store.setMeta(fx.FX_FETCHED_AT_KEY, new Date(now).toISOString());
    expect(fx.fxRefreshDue(store, 24, now + 3_600_000)).toBe(false);
    expect(fx.fxRefreshDue(store, 24, now + 25 * 3_600_000)).toBe(true);
  });

  it("retries a corrupt fetch timestamp rather than wedging", () => {
    const store = openStore();
    store.setMeta(fx.FX_FETCHED_AT_KEY, "not a date");
    expect(fx.fxRefreshDue(store, 24)).toBe(true);
  });

  it("boots without a fetch from a fresh cache but refreshes a stale one", async () => {
    const now = Date.parse("2026-09-20T00:00:00.000Z");

    const fresh = openStore();
    await fx.refreshFxRates(fresh, async () => GOOD_PAYLOAD, now);
    let calls = 0;
    await fx.bootFxRefresh(fresh, {
      hours: 24,
      fetchJson: async () => {
        calls++;
        return GOOD_PAYLOAD;
      },
      now: () => now + 3_600_000,
    });
    expect(calls).toBe(0);

    await fx.bootFxRefresh(fresh, {
      hours: 24,
      fetchJson: async () => {
        calls++;
        return GOOD_PAYLOAD;
      },
      now: () => now + 25 * 3_600_000,
    });
    expect(calls).toBe(1);
  });

  it("startFxRefresh returns a stop function", () => {
    const store = openStore();
    const stop = fx.startFxRefresh(store, {
      hours: 24,
      fetchJson: async () => GOOD_PAYLOAD,
    });
    expect(typeof stop).toBe("function");
    stop();
  });
});

describe("FX_REFRESH_HOURS configuration", () => {
  // Controlled explicitly: reading the ambient environment would make the suite
  // red for anyone who set the knob (or dropped it in a local .env). dotenv runs
  // once at import and never overrides an existing value, so deleting the key
  // here is a clean "unset" regardless of what .env holds.
  const KEY = "FX_REFRESH_HOURS";
  const saved = process.env[KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("defaults to a daily refresh", () => {
    delete process.env[KEY];
    expect(loadEnv().fxRefreshHours).toBe(24);
  });

  it("honours an explicit cadence and 0 to disable", () => {
    process.env[KEY] = "6";
    expect(loadEnv().fxRefreshHours).toBe(6);
    process.env[KEY] = "0";
    expect(loadEnv().fxRefreshHours).toBe(0);
  });

  it("falls back to the default for empty, negative, and non-numeric values", () => {
    for (const raw of ["", "   ", "abc", "-5", "1e400"]) {
      process.env[KEY] = raw;
      expect(loadEnv().fxRefreshHours, `raw=${JSON.stringify(raw)}`).toBe(24);
    }
  });
});

// ── rate consistency: values derived at read time, not at ingest ─────────────

function payload(rates: Record<string, number>) {
  return { result: "success", base_code: "USD", rates };
}

function listing(id: string, price: number, currency: "JPY" | "USD" = "JPY", brandKey?: string) {
  const l = normalizeListing({
    market: "yahoo",
    id,
    title: `${brandKey ?? ""} test item ${id}`.trim(),
    price,
    currency,
    url: `https://example.test/${id}`,
  });
  if (brandKey) l.brandKey = brandKey;
  return l;
}

describe("stored USD values follow the rate in force, not the ingest rate", () => {
  it("re-derives priceUsd when the rate moves, keeping the ingest record", async () => {
    const store = openStore();
    store.upsertListing(listing("j1", 15_500)); // $100 at the static 155 JPY/USD
    expect(store.get("yahoo", "j1")!.priceUsd).toBe(100);
    expect(store.get("yahoo", "j1")!.fxRate).toBeCloseTo(1 / 155, 8);

    await fx.refreshFxRates(store, async () => payload({ USD: 1, JPY: 150 }));

    // The column still holds the ingest-time value...
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const row = raw.prepare("SELECT priceUsd, fxRate FROM listings WHERE key = ?").get("yahoo:j1") as unknown as {
      priceUsd: number;
      fxRate: number;
    };
    raw.close();
    expect(row.priceUsd).toBe(100);
    expect(row.fxRate).toBeCloseTo(1 / 155, 8);

    // ...while the read is converted at the rate now in force.
    expect(store.get("yahoo", "j1")!.priceUsd).toBeCloseTo(103.33, 2);
  });

  it("keeps a whole page on one rate", async () => {
    const store = openStore();
    store.upsertListing(listing("a", 15_500));
    await fx.refreshFxRates(store, async () => payload({ USD: 1, JPY: 310 }));
    store.upsertListing(listing("b", 15_500));

    const page = store.recentListings(24);
    expect(page).toHaveLength(2);
    expect(new Set(page.map((r) => r.priceUsd)).size).toBe(1); // no vintage mix
    expect(page[0]!.priceUsd).toBe(50); // both at 310, not one at 155
  });

  it("buckets the comp band at the current rate, so a moved rate re-buckets consistently", async () => {
    const store = openStore();
    store.upsertListing(listing("c1", 15_500, "JPY", "cdg"));

    // At the static rate: 15500/155 = $100 → band 100.
    expect(store.recentByBrandRounded("cdg", 50, 100, 24).map((r) => r.marketId)).toEqual(["c1"]);

    await fx.refreshFxRates(store, async () => payload({ USD: 1, JPY: 310 }));

    // 15500/310 = $50 → it belongs to band 50 now, and must have left band 100.
    expect(store.recentByBrandRounded("cdg", 50, 100, 24)).toHaveLength(0);
    expect(store.recentByBrandRounded("cdg", 50, 50, 24).map((r) => r.marketId)).toEqual(["c1"]);
  });

  it("derives deal prices at the current rate too", async () => {
    const store = openStore();
    const l = listing("d1", 15_500, "JPY", "cdg");
    store.upsertListing(l);
    store.recordDeal({
      listing: l,
      proxy: {},
      reasons: [{ kind: "threshold", detail: "test reason" }],
      score: 40,
    });
    expect(store.recentDeals(["all"], 10)[0]!.listing.priceUsd).toBe(100);

    await fx.refreshFxRates(store, async () => payload({ USD: 1, JPY: 310 }));
    expect(store.recentDeals(["all"], 10)[0]!.listing.priceUsd).toBe(50);
  });

  it("an unknown currency falls back to the stored value instead of throwing", () => {
    const store = openStore();
    const l = listing("e1", 100, "USD");
    store.upsertListing(l);
    // Forge a currency the rate table does not know (a future market's row).
    store.transaction(() => {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE listings SET currency = 'SEK' WHERE key = ?").run("yahoo:e1");
      db.close();
    });
    expect(store.get("yahoo", "e1")!.priceUsd).toBe(100);
  });
});

describe("provenance, age, and staleness", () => {
  const NOON = Date.parse("2026-09-20T12:00:00.000Z");
  const HOUR = 3_600_000;

  it("labels live, cached-with-age, stale, and static", async () => {
    const store = openStore();
    expect(fx.fxStatusLabel(24, NOON)).toBe("static");

    await fx.refreshFxRates(store, async () => GOOD_PAYLOAD, NOON);
    expect(fx.fxStatusLabel(24, NOON)).toBe("live");

    fx.resetFxRates();
    const restored = openStore();
    expect(fx.restoreFxRates(restored)).toBe(true);
    expect(fx.fxAgeHours(NOON)).toBe(0);
    expect(fx.fxStatusLabel(24, NOON + 2 * HOUR)).toBe("cached 2h");
    // Past 2x the cadence the cache is called what it is.
    expect(fx.fxStatusLabel(24, NOON + 49 * HOUR)).toBe("stale 2d");
  });

  it("never calls anything stale when the cadence is off", async () => {
    const store = openStore();
    await fx.refreshFxRates(store, async () => GOOD_PAYLOAD, NOON);
    fx.resetFxRates();
    expect(fx.restoreFxRates(openStore())).toBe(true);
    expect(fx.fxStatusLabel(0, NOON + 1000 * HOUR)).toBe("cached 42d");
  });

  it("appends the failure count so a failing refresh is visible", async () => {
    const store = openStore();
    await fx.refreshFxRates(store, async () => GOOD_PAYLOAD, NOON);
    await fx.refreshFxRates(store, async () => {
      throw new Error("offline");
    });
    expect(fx.fxStatusLabel(24, NOON)).toBe("live, 1 failed");
  });
});

describe("degradation alerting", () => {
  it("fires the handler once per failure streak, at the threshold", async () => {
    const store = openStore();
    const alerts: fx.FxDegradedInfo[] = [];
    const boom = async (): Promise<unknown> => {
      throw new Error("offline");
    };
    const onDegraded = (info: fx.FxDegradedInfo) => alerts.push(info);

    for (let i = 0; i < 5; i++) await fx.refreshFxRates(store, boom, Date.now(), onDegraded);

    expect(fx.fxConsecutiveFailures()).toBe(5);
    expect(alerts).toHaveLength(1); // stays one alert, not one per tick
    expect(alerts[0]!.consecutiveFailures).toBe(fx.FX_ALERT_AFTER_FAILURES);
    expect(alerts[0]!.reason).toBe("fetch failed");
  });

  it("a success clears the streak, so a later outage alerts again", async () => {
    const store = openStore();
    const alerts: fx.FxDegradedInfo[] = [];
    const onDegraded = (info: fx.FxDegradedInfo) => alerts.push(info);
    const boom = async (): Promise<unknown> => {
      throw new Error("offline");
    };

    for (let i = 0; i < 3; i++) await fx.refreshFxRates(store, boom, Date.now(), onDegraded);
    await fx.refreshFxRates(store, async () => GOOD_PAYLOAD);
    expect(fx.fxConsecutiveFailures()).toBe(0);

    for (let i = 0; i < 3; i++) await fx.refreshFxRates(store, boom, Date.now(), onDegraded);
    expect(alerts).toHaveLength(2);
  });

  it("alerts on a sustained invalid payload too", async () => {
    const store = openStore();
    const alerts: fx.FxDegradedInfo[] = [];
    for (let i = 0; i < 3; i++) {
      await fx.refreshFxRates(store, async () => ({ rates: { USD: 1 } }), Date.now(), (info) =>
        alerts.push(info),
      );
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.reason).toBe("invalid payload");
  });

  it("a throwing handler cannot break the refresh path", async () => {
    const store = openStore();
    const res = await fx.refreshFxRates(
      store,
      async () => {
        throw new Error("offline");
      },
      Date.now(),
      () => {
        throw new Error("handler exploded");
      },
    );
    expect(res.ok).toBe(false);
    expect(fx.fxConsecutiveFailures()).toBe(1);
  });
});

describe("pure conversion helpers", () => {
  it("usdFrom converts at only the rates it is handed", () => {
    const rates = { USD: 1, JPY: 1 / 200 };
    expect(fx.usdFrom(200, "JPY", rates)).toBeCloseTo(1, 8);
    expect(fx.usdFrom(7, "usd", rates)).toBe(7);
    expect(() => fx.usdFrom(1, "EUR", rates)).toThrow(/Unknown currency/);
  });

  it("a snapshot stays put while the live set changes", async () => {
    const store = openStore();
    const before = fx.fxRatesSnapshot();
    await fx.refreshFxRates(store, async () => payload({ USD: 1, JPY: 150 }));
    expect(before.JPY).toBeCloseTo(1 / 155, 8); // captured, not a live view
    expect(fx.fxRatesSnapshot().JPY).toBeCloseTo(1 / 150, 8);
    expect(fx.jpyUsdRate()).toBeCloseTo(1 / 150, 8);
  });

  it("reference currencies the payload omits keep their compiled-in values", async () => {
    const store = openStore();
    await fx.refreshFxRates(store, async () => payload({ USD: 1, JPY: 150 }));
    expect(fx.currentFxRates().EUR).toBe(1.08);
    expect(fx.currentFxRates().GBP).toBe(1.27);
    expect(fx.currentFxRates().JPY).toBeCloseTo(1 / 150, 8);
  });

  it("round2 is money precision, and is not what a rate gets stored as", () => {
    expect(fx.round2(103.333)).toBe(103.33);
    expect(fx.round2(103.336)).toBe(103.34);
    // The reason store.ts keeps the raw rate: cents would destroy a yen rate.
    expect(fx.round2(1 / 155)).toBe(0.01);
    expect(fx.round2(1 / 155)).not.toBeCloseTo(1 / 155, 4);
  });
});
