import type { Store } from "./store.js";
import { logger } from "../logger.js";

/**
 * FX rates with cached fallback.
 *
 * Resolution order is live → cached snapshot → static table:
 *   live   — a successful fetch in this process
 *   cached — the last snapshot restored from the store's meta table
 *   static — the compiled-in table below, when no snapshot is available
 *
 * `toUsd` converts through whatever set is currently in force. The static table
 * is only the starting value and the fallback; it is never mutated.
 */

/** Compiled-in fallback table, USD per unit. */
export const STATIC_FX_RATES: Readonly<Record<string, number>> = {
  JPY: 1 / 155, // 1 JPY ≈ $0.00645
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
};

/**
 * Currencies a payload must supply. A partial set is rejected rather than
 * merged: `toUsd` throws on a currency it does not know, so a live set that
 * lost JPY would break every yen listing.
 */
export const FX_CURRENCIES = ["USD", "JPY", "EUR", "GBP"] as const;

/** Keyless rate API. Its `rates` are units-per-USD, so USD-per-unit is 1/value. */
export const FX_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";

/** Store meta keys for the cache. */
export const FX_SNAPSHOT_KEY = "fx:snapshot";
export const FX_FETCHED_AT_KEY = "fx:fetchedAt";

export type FxSource = "live" | "cached" | "static";

/** One rate payload. Injected so tests never touch the network. */
export type FxFetch = () => Promise<unknown>;

let currentRates: Record<string, number> = { ...STATIC_FX_RATES };
let source: FxSource = "static";

export function toUsd(amount: number, currency: string): number {
  const rate = currentRates[currency.toUpperCase()];
  if (rate === undefined) throw new Error(`Unknown currency: ${currency}`);
  return amount * rate;
}

/** The rate set currently in force. */
export function currentFxRates(): Readonly<Record<string, number>> {
  return currentRates;
}

/** Where the rates in force came from — for logs and operator surfaces. */
export function fxSourceName(): FxSource {
  return source;
}

/**
 * Turn an API payload into USD-per-unit rates, or null when it is unusable.
 * Rejects anything that would corrupt state: a non-object payload, a missing
 * `rates` map, or a value that is not a positive finite number.
 */
export function parseFxRates(payload: unknown): Record<string, number> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { rates?: unknown }).rates;
  if (typeof raw !== "object" || raw === null) return null;
  const rates = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const code of FX_CURRENCIES) {
    const perUsd = rates[code];
    if (typeof perUsd !== "number" || !Number.isFinite(perUsd) || perUsd <= 0) return null;
    out[code] = 1 / perUsd;
  }
  return out;
}

/**
 * Apply the cached snapshot. Returns false — leaving the static table in force —
 * when there is no snapshot, it is unreadable or malformed, or the store itself
 * is unusable: a new or unwritable database must never stop the bot serving.
 */
export function restoreFxRates(store: Store): boolean {
  let raw: string | undefined;
  try {
    raw = store.getMeta(FX_SNAPSHOT_KEY);
  } catch (err) {
    logger.warn({ err }, "fx snapshot unreadable — serving the static table");
    return false;
  }
  if (raw === undefined) return false;

  let rates: Record<string, number> | null;
  try {
    rates = parseFxRates(JSON.parse(raw));
  } catch {
    rates = null;
  }
  if (rates === null) {
    logger.warn("fx snapshot failed validation — serving the static table");
    return false;
  }

  currentRates = rates;
  source = "cached";
  return true;
}

/** Test seam: drop back to the compiled-in table. */
export function resetFxRates(): void {
  currentRates = { ...STATIC_FX_RATES };
  source = "static";
}

/** Is the cache stale enough to refresh? `hours <= 0` means never. */
export function fxRefreshDue(store: Store, hours: number, now = Date.now()): boolean {
  if (hours <= 0) return false;
  let raw: string | undefined;
  try {
    raw = store.getMeta(FX_FETCHED_AT_KEY);
  } catch {
    return true; // no readable cache — worth a fetch attempt
  }
  if (raw === undefined) return true;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return true;
  return now - at >= hours * 3_600_000;
}

export interface FxRefreshResult {
  ok: boolean;
  /** The source in force once the attempt finished. */
  source: FxSource;
  reason?: string;
}

/**
 * Fetch, validate, cache, and apply one rate set.
 *
 * A failed fetch or an invalid payload leaves the rates already in force
 * untouched — the caller keeps serving the cached snapshot or the static table
 * rather than a half-updated set. A store that cannot be written is logged but
 * does not discard good rates; the cache simply does not outlive the process.
 */
export async function refreshFxRates(
  store: Store,
  fetchJson: FxFetch,
  now = Date.now(),
): Promise<FxRefreshResult> {
  let payload: unknown;
  try {
    payload = await fetchJson();
  } catch (err) {
    logger.warn({ err }, "fx fetch failed — keeping the rates already in force");
    return { ok: false, source, reason: "fetch failed" };
  }

  const rates = parseFxRates(payload);
  if (rates === null) {
    logger.warn("fx payload failed validation — keeping the rates already in force");
    return { ok: false, source, reason: "invalid payload" };
  }

  try {
    store.setMeta(FX_SNAPSHOT_KEY, JSON.stringify(payload));
    store.setMeta(FX_FETCHED_AT_KEY, new Date(now).toISOString());
  } catch (err) {
    logger.warn({ err }, "fx snapshot not persisted — rates apply to this process only");
  }

  currentRates = rates;
  source = "live";
  logger.info({ currencies: FX_CURRENCIES.length }, "fx rates refreshed");
  return { ok: true, source: "live" };
}

export interface FxBootOptions {
  /** Refresh cadence in hours; 0 keeps the static table and never fetches. */
  hours: number;
  fetchJson: FxFetch;
  now?: () => number;
}

/**
 * Boot entry: apply the cached snapshot (always, synchronously) and then
 * refresh only when the cadence says the cache is stale.
 */
export async function bootFxRefresh(store: Store, opts: FxBootOptions): Promise<FxRefreshResult> {
  restoreFxRates(store);
  const now = opts.now?.() ?? Date.now();
  if (!fxRefreshDue(store, opts.hours, now)) return { ok: true, source };
  return refreshFxRates(store, opts.fetchJson, now);
}

/** Boot catch-up plus an hourly tick. Returns a stop function. */
export function startFxRefresh(store: Store, opts: FxBootOptions): () => void {
  const run = () => {
    void bootFxRefresh(store, opts).catch((err) => {
      logger.error({ err }, "fx refresh failed — will retry next tick");
    });
  };
  run();
  const timer = setInterval(run, 3_600_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
