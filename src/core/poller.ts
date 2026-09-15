import type { MarketId, PollResult, Listing, Deal } from "../types.js";
import { MARKET_LABEL } from "../types.js";
import type { MarketAdapter } from "../markets/types.js";
import type { Store } from "./store.js";
import { evaluateDeal } from "./score.js";
import { logger } from "../logger.js";
import { jitter, sleep } from "./http.js";

export interface PollerOptions {
  pollSeconds: Record<MarketId, number>;
  compRoundUsd: number;
  /** Operator-configured watch keys (SWAGSCOUT_WATCH). Empty = auto. */
  watchKeys?: string[];
}

interface MarketRuntime {
  adapter: MarketAdapter;
  enabled: boolean;
  consecutiveFailures: number;
  openUntil: number; // circuit breaker open until this timestamp
  lastIndex: number;
}

const MAX_FAILURES_BEFORE_BREAKER = 5;
const BREAKER_OPEN_MS = 5 * 60_000;

/**
 * Rotates each market through its watch queries, dedupes against the store,
 * evaluates deals, and hands results to the notifier callback.
 */
export class Poller {
  private runtimes = new Map<MarketId, MarketRuntime>();
  private timers = new Map<MarketId, NodeJS.Timeout>();
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly adapters: MarketAdapter[],
    private readonly opts: PollerOptions,
    private readonly onResults: (results: PollResult[]) => Promise<void>,
  ) {
    for (const a of adapters) {
      this.runtimes.set(a.id, {
        adapter: a,
        enabled: a.id !== "ebay" || this.isEbayEnabled(a),
        consecutiveFailures: 0,
        openUntil: 0,
        lastIndex: 0,
      });
    }
  }

  private isEbayEnabled(a: MarketAdapter): boolean {
    return "enabled" in a ? Boolean((a as { enabled?: boolean }).enabled) : true;
  }

  /** Query list for a market: brand search terms (deduped). */
  private queriesFor(market: MarketId): string[] {
    const brandKeys = new Set<string>();
    if (this.opts.watchKeys && this.opts.watchKeys.length > 0) {
      for (const key of this.opts.watchKeys) brandKeys.add(key);
    } else {
      const watches = this.store.listSubscriptions();
      for (const w of watches) {
        if (w.watch === "all") {
          // global watch → poll every brand (falls through to default list)
          brandKeys.clear();
          break;
        }
        brandKeys.add(w.watch);
      }
    }
    const terms = new Set<string>();
    for (const key of brandKeys) {
      const brand = BRAND_CACHE.get(key);
      if (!brand) continue;
      for (const t of brand.searchTerms) terms.add(t);
    }
    if (terms.size === 0) {
      // default: poll the curated default watch list
      for (const brand of DEFAULT_BRAND_KEYS) {
        const b = BRAND_CACHE.get(brand);
        if (b) for (const t of b.searchTerms) terms.add(t);
      }
    }
    void market;
    return [...terms];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (const [market, rt] of this.runtimes) {
      if (!rt.enabled) {
        logger.info({ market }, "market disabled (missing credentials)");
        continue;
      }
      const seconds = this.opts.pollSeconds[market] ?? 60;
      const tick = async () => {
        if (!this.running) return;
        const result = await this.pollMarket(market).catch((err) => {
          logger.error({ err, market }, "poll tick failed");
          return null;
        });
        if (result) {
          // deliver deals from every recurring poll, not just smoke runs
          await this.onResults([result]).catch((err) =>
            logger.error({ err, market }, "result handler failed"),
          );
        }
        if (this.running) {
          const next = jitter(seconds * 1000);
          this.timers.set(market, setTimeout(tick, next));
        }
      };
      // stagger initial polls
      const initialDelay = jitter(seconds * 1000 * 0.2);
      this.timers.set(market, setTimeout(tick, initialDelay));
      logger.info({ market: MARKET_LABEL[market], intervalSec: seconds }, "poller scheduled");
    }
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Poll one market once (also used by smoke tests). */
  async pollMarket(market: MarketId): Promise<PollResult> {
    const rt = this.runtimes.get(market);
    if (!rt) throw new Error(`unknown market ${market}`);
    const now = Date.now();

    if (now < rt.openUntil) {
      return { market, fetched: 0, newListings: 0, priceDrops: 0, deals: [], error: "circuit-open" };
    }

    const queries = this.queriesFor(market);
    let fetched = 0;
    let newListings = 0;
    let priceDrops = 0;
    const deals: Deal[] = [];

    try {
      // rotate through queries, one brand step per tick to stay polite
      const query = queries[rt.lastIndex % queries.length] ?? queries[0];
      rt.lastIndex = (rt.lastIndex + 1) % Math.max(queries.length, 1);

      if (query) {
        const listings = await rt.adapter.search(query, { maxItems: 50 });
        fetched = listings.length;
        await sleep(50); // tiny breather before db writes

        for (const listing of listings) {
          const existing = this.store.get(listing.market, listing.id);
          if (!existing) {
            this.store.upsertListing(listing);
            newListings++;
            const deal = evaluateDeal(listing, {
              store: this.store,
              compRoundUsd: this.opts.compRoundUsd,
            });
            if (deal) {
              deals.push(deal);
              this.store.recordDeal(deal);
            }
          } else if (listing.priceUsd < existing.priceUsd * 0.97) {
            // price drop ≥3%
            this.store.upsertListing(listing);
            priceDrops++;
            const deal = evaluateDeal(listing, {
              store: this.store,
              compRoundUsd: this.opts.compRoundUsd,
            });
            if (deal) {
              deal.reasons.push({
                kind: "price_drop",
                detail: `dropped from $${existing.priceUsd.toFixed(0)} to $${listing.priceUsd.toFixed(0)}`,
              });
              deals.push(deal);
              this.store.recordDeal(deal);
            }
          }
        }
      }

      rt.consecutiveFailures = 0;
    } catch (err) {
      rt.consecutiveFailures++;
      if (rt.consecutiveFailures >= MAX_FAILURES_BEFORE_BREAKER) {
        rt.openUntil = Date.now() + BREAKER_OPEN_MS;
        rt.consecutiveFailures = 0;
        logger.warn({ market }, "circuit breaker OPEN for 5m");
      }
      return {
        market,
        fetched,
        newListings,
        priceDrops,
        deals,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    logger.info(
      { market: MARKET_LABEL[market], fetched, newListings, deals: deals.length },
      "poll complete",
    );
    return { market, fetched, newListings, priceDrops, deals };
  }

  /** Poll every enabled market once, in parallel (used by smoke runs). */
  async pollAllOnce(): Promise<PollResult[]> {
    const enabled = [...this.runtimes.entries()].filter(([, rt]) => rt.enabled);
    const results = await Promise.all(
      enabled.map(([m]) => this.pollMarket(m).catch((err) => ({
        market: m,
        fetched: 0,
        newListings: 0,
        priceDrops: 0,
        deals: [],
        error: err instanceof Error ? err.message : String(err),
      }) as PollResult)),
    );
    await this.onResults(results);
    return results;
  }
}

// Avoid a circular import: brands are loaded lazily into this cache.
import { BRANDS } from "../config/brands.js";
const BRAND_CACHE = new Map(BRANDS.map((b) => [b.key, b]));
/**
 * Default watch when nothing is subscribed/configured. Explicit list so
 * catalog position never silently drops a brand from polling.
 */
const DEFAULT_BRAND_KEYS = [
  "cdg",
  "yohji",
  "number-nine",
  "issey",
  "raf",
  "undercover",
  "undercoverism",
  "junya-watanabe",
  "margiela",
  "helmut-lang",
  "rick-owens",
  "visvim",
  "kapital",
  "needles",
  "bape",
  "evisu",
  "supreme",
];
