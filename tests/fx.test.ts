import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/core/store.js";
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
