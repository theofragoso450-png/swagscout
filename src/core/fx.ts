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
 * Currencies a payload must supply — exactly the ones that can reach `toUsd`,
 * i.e. the ones a listing can be denominated in (`Listing["currency"]`).
 *
 * Demanding more would be a silent failure mode for nothing: EUR and GBP are
 * carried in the static table for reference but no market or listing uses them,
 * so an upstream gap in either would otherwise invalidate an otherwise perfect
 * JPY/USD payload and quietly pin pricing to the previous vintage.
 */
export const FX_CURRENCIES = ["USD", "JPY"] as const;

/** Currencies carried in the static table but never converted. */
export const FX_REFERENCE_CURRENCIES = ["EUR", "GBP"] as const;

/** Keyless rate API. Its `rates` are units-per-USD, so USD-per-unit is 1/value. */
export const FX_SOURCE_URL = "https://open.er-api.com/v6/latest/USD";

/** Store meta keys for the cache. */
export const FX_SNAPSHOT_KEY = "fx:snapshot";
export const FX_FETCHED_AT_KEY = "fx:fetchedAt";

export type FxSource = "live" | "cached" | "static";

/** One rate payload. Injected so tests never touch the network. */
export type FxFetch = () => Promise<unknown>;

/** Round a USD amount to cents — the canonical money precision. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Consecutive refresh failures that make silent price drift worth a human.
 *  A single miss is noise (the cached snapshot is still serving); a streak is a
 *  signal that the endpoint moved or the network is gone. */
export const FX_ALERT_AFTER_FAILURES = 3;

/** How many cadence periods a cache may age before it is called stale. */
export const FX_STALE_MULTIPLIER = 2;

let currentRates: Record<string, number> = { ...STATIC_FX_RATES };
let source: FxSource = "static";
let fetchedAt: number | null = null;
let consecutiveFailures = 0;

/**
 * Convert at an explicit rate set. Pure, so a caller doing several related
 * conversions (a candidate and its comps) can pin ONE set and stay
 * self-consistent even if a refresh lands midway.
 */
export function usdFrom(
  amount: number,
  currency: string,
  rates: Readonly<Record<string, number>>,
): number {
  const rate = rates[currency.toUpperCase()];
  if (rate === undefined) throw new Error(`Unknown currency: ${currency}`);
  return amount * rate;
}

export function toUsd(amount: number, currency: string): number {
  return usdFrom(amount, currency, currentRates);
}

/** The rate set currently in force. */
export function currentFxRates(): Readonly<Record<string, number>> {
  return currentRates;
}

/**
 * Capture the rates in force so a batch of conversions shares one vintage.
 * Read paths convert stored prices through this rather than the per-ingest
 * rates baked into the database, so every value in one response agrees.
 */
export function fxRatesSnapshot(): Readonly<Record<string, number>> {
  return currentRates;
}

/**
 * The JPY→USD factor in force — this bot's primary conversion, and the one the
 * price-band SQL needs as a bound parameter. Total by design: fall back to the
 * compiled-in value rather than throwing inside a read path.
 */
export function jpyUsdRate(rates: Readonly<Record<string, number>> = currentRates): number {
  return rates.JPY ?? STATIC_FX_RATES.JPY ?? 1 / 155;
}

/** Where the rates in force came from — for logs and operator surfaces. */
export function fxSourceName(): FxSource {
  return source;
}

/** When the rates in force were fetched, or null for the static table. */
export function fxFetchedAt(): number | null {
  return fetchedAt;
}

/** Age of the rates in force in hours, or null when there is no fetch to age. */
export function fxAgeHours(now = Date.now()): number | null {
  if (fetchedAt === null) return null;
  return Math.max(0, (now - fetchedAt) / 3_600_000);
}

/** Consecutive failed refresh attempts since the last success. */
export function fxConsecutiveFailures(): number {
  return consecutiveFailures;
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * One compact label for operator surfaces: provenance, age, and whether the
 * rates have outlived the cadence.
 *
 * "cached" alone cannot distinguish a snapshot from a minute ago from one that
 * has not refreshed in a month — if the endpoint moves, the label would read
 * healthy forever while prices drifted. The age and the stale verdict are what
 * make a failing refresh visible. `hours <= 0` never calls anything stale.
 */
export function fxStatusLabel(hours: number, now = Date.now()): string {
  const failures = consecutiveFailures > 0 ? `, ${consecutiveFailures} failed` : "";
  if (source === "live") return `live${failures}`;
  if (source === "static") return `static${failures}`;

  const age = fxAgeHours(now);
  if (age === null) return `cached${failures}`;
  const stale = hours > 0 && age >= hours * FX_STALE_MULTIPLIER;
  return `${stale ? "stale" : "cached"} ${formatAge(age)}${failures}`;
}

/**
 * Turn an API payload into USD-per-unit rates, or null when it is unusable.
 *
 * Only the convertible currencies are required; any other currency is taken
 * best-effort when present and ignored when not, so an upstream gap in a rate
 * this bot never divides by cannot sink an otherwise good payload. Rejects a
 * non-object payload, a missing `rates` map, and a required value that is not
 * a positive finite number.
 */
export function parseFxRates(payload: unknown): Record<string, number> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as { rates?: unknown }).rates;
  if (typeof raw !== "object" || raw === null) return null;
  const rates = raw as Record<string, unknown>;

  const positive = (code: string): number | undefined => {
    const perUsd = rates[code];
    if (typeof perUsd !== "number" || !Number.isFinite(perUsd) || perUsd <= 0) return undefined;
    return 1 / perUsd;
  };

  const out: Record<string, number> = {};
  for (const code of FX_CURRENCIES) {
    const rate = positive(code);
    if (rate === undefined) return null; // a currency we convert is missing/bad
    out[code] = rate;
  }
  for (const code of FX_REFERENCE_CURRENCIES) {
    const rate = positive(code);
    if (rate !== undefined) out[code] = rate; // best-effort only
  }
  return out;
}

/** Apply a parsed set over the static table, so a reference currency the
 *  payload omitted keeps its compiled-in value instead of disappearing. */
function applyRates(parsed: Record<string, number>): void {
  currentRates = { ...STATIC_FX_RATES, ...parsed };
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

  applyRates(rates);
  source = "cached";
  try {
    const at = Date.parse(store.getMeta(FX_FETCHED_AT_KEY) ?? "");
    fetchedAt = Number.isFinite(at) ? at : null;
  } catch {
    fetchedAt = null; // unreadable timestamp must not break the restore
  }
  return true;
}

/** Test seam: drop back to the compiled-in table. */
export function resetFxRates(): void {
  currentRates = { ...STATIC_FX_RATES };
  source = "static";
  fetchedAt = null;
  consecutiveFailures = 0;
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
  onDegraded?: FxDegradedHandler,
): Promise<FxRefreshResult> {
  let payload: unknown;
  try {
    payload = await fetchJson();
  } catch (err) {
    return failed("fetch failed", err, onDegraded);
  }

  const rates = parseFxRates(payload);
  if (rates === null) {
    return failed("invalid payload", undefined, onDegraded);
  }

  try {
    store.setMeta(FX_SNAPSHOT_KEY, JSON.stringify(payload));
    store.setMeta(FX_FETCHED_AT_KEY, new Date(now).toISOString());
  } catch (err) {
    logger.warn({ err }, "fx snapshot not persisted — rates apply to this process only");
  }

  applyRates(rates);
  source = "live";
  fetchedAt = now;
  consecutiveFailures = 0;
  logger.info({ currencies: FX_CURRENCIES.length }, "fx rates refreshed");
  return { ok: true, source: "live" };
}

/**
 * Record a failed attempt: keep the rates in force, count the streak, and fire
 * the degradation handler exactly once per streak (at the threshold) so an
 * endpoint that has moved does not drift prices silently forever.
 */
function failed(reason: string, err: unknown, onDegraded?: FxDegradedHandler): FxRefreshResult {
  consecutiveFailures++;
  logger.warn(
    { reason, err, consecutiveFailures },
    "fx refresh failed — keeping the rates already in force",
  );
  if (onDegraded && consecutiveFailures === FX_ALERT_AFTER_FAILURES) {
    try {
      onDegraded({ consecutiveFailures, reason, label: fxStatusLabel(0) });
    } catch (hookErr) {
      logger.error({ err: hookErr }, "fx degradation handler threw");
    }
  }
  return { ok: false, source, reason };
}

export interface FxDegradedInfo {
  consecutiveFailures: number;
  reason: string;
  label: string;
}

/** Called once per failure streak, when it reaches FX_ALERT_AFTER_FAILURES. */
export type FxDegradedHandler = (info: FxDegradedInfo) => void;

export interface FxBootOptions {
  /** Refresh cadence in hours; 0 keeps the static table and never fetches. */
  hours: number;
  fetchJson: FxFetch;
  now?: () => number;
  /** Notified when refreshes have failed long enough to matter. */
  onDegraded?: FxDegradedHandler;
}

/**
 * Boot entry: apply the cached snapshot (always, synchronously) and then
 * refresh only when the cadence says the cache is stale.
 */
export async function bootFxRefresh(store: Store, opts: FxBootOptions): Promise<FxRefreshResult> {
  restoreFxRates(store);
  const now = opts.now?.() ?? Date.now();
  if (!fxRefreshDue(store, opts.hours, now)) return { ok: true, source };
  return refreshFxRates(store, opts.fetchJson, now, opts.onDegraded);
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
