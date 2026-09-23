import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ALL_MARKETS, type Deal, type DealReason, type Listing, type MarketHealth, type MarketId } from "../types.js";
import { proxyLinks } from "../proxy/links.js";
import { PIPELINE_VERSION } from "./pipeline.js";
import { fxRatesSnapshot, jpyUsdRate, round2, usdFrom } from "./fx.js";

/**
 * Re-derive a row's USD value from its native price at a pinned rate set.
 *
 * The stored `priceUsd` is the rate that was in force at INGEST, so it is a
 * mix of vintages the moment rates move: a comp window spanning a refresh would
 * median values converted at different rates, and a price band would bucket on
 * a stale number. Deriving at read time from the stored native price + currency
 * (both always present) puts every value in a response on one rate. The stored
 * column stays as the ingest record and as the fallback for a currency we
 * cannot convert.
 */
function withCurrentUsd<T extends { price: number; currency: string; priceUsd: number }>(
  row: T,
  rates: Readonly<Record<string, number>>,
): T {
  try {
    return { ...row, priceUsd: round2(usdFrom(row.price, row.currency, rates)) };
  } catch {
    return row;
  }
}

export interface StoredListing {
  key: string; // `${market}:${id}`
  market: MarketId;
  marketId: string;
  title: string;
  brandKey: string | null;
  item: string | null;
  size: string | null;
  condition: string | null;
  price: number;
  currency: string;
  priceUsd: number;
  url: string;
  imageUrl: string | null;
  endsAt: string | null;
  foundAt: string;
  updatedAt: string;
  /** Null while the listing appears in complete poll rounds; set when last seen. */
  missingSince: string | null;
  /** The currency factor baked into `priceUsd` at ingest (null = pre-column).
   *  Kept for auditing which rate vintage a row was written under; reads do not
   *  trust it. */
  fxRate: number | null;
}

/**
 * Gone-within-48h churn for one brand's last-N sightings. Honest by
 * construction: "gone" is absence from complete poll rounds, never proof of
 * sale.
 */
export interface VelocityStat {
  /** Sightings considered (≤ n; fewer when the brand has less history). */
  observed: number;
  /** Of those, how many are currently absent. */
  gone: number;
  /** Of those, how many vanished ≤48h after being found. */
  goneWithin48h: number;
  /** goneWithin48h / observed (0 when nothing observed). */
  rate: number;
}

const GONE_WITHIN_MS = 48 * 3_600_000;

function velocityStat(rows: Array<{ foundAt: string; missingSince: string | null }>): VelocityStat {
  let gone = 0;
  let within = 0;
  for (const r of rows) {
    if (r.missingSince === null) continue;
    gone++;
    const t = Date.parse(r.missingSince) - Date.parse(r.foundAt);
    if (Number.isFinite(t) && t >= 0 && t <= GONE_WITHIN_MS) within++;
  }
  return { observed: rows.length, gone, goneWithin48h: within, rate: rows.length ? within / rows.length : 0 };
}

/** One observation in a listing's append-only price history. */
export interface PriceEvent {
  /** ISO instant of the observation. */
  at: string;
  /** Native price at that instant. */
  price: number;
  currency: string;
  /** USD value at the rate in force when the event was written. */
  priceUsd: number;
}

export interface Subscription {
  guildId: string;
  channelId: string;
  /** brand key or "all" */
  watch: string;
  /** minimum deal score to alert in this channel */
  minScore: number;
  /** optional exact-size filter (case-insensitive); null = all sizes */
  size?: string | null;
}

/**
 * Persistence layer on Node's built-in `node:sqlite` (no native compile step).
 * Tracks seen listings (dedupe), price history (drops), deal history and
 * per-channel Discord subscriptions.
 */
export class Store {
  private db: DatabaseSync;

  private hasStmt: StatementSync;
  private getStmt: StatementSync;
  private upsertListingStmt: StatementSync;
  private recentStmt: StatementSync;
  private recentByBrandStmt: StatementSync;
  private recentByBrandRoundedStmt: StatementSync;
  private addSubStmt: StatementSync;
  private deleteSubStmt: StatementSync;
  private listSubStmt: StatementSync;
  private setMetaStmt: StatementSync;
  private getMetaStmt: StatementSync;
  /** Per-market 24h row counts + newest-row timestamp (see marketHealth). */
  private marketActivityStmt: StatementSync;
  private insertDealStmt: StatementSync;
  private recentDealsStmt: StatementSync;
  private recentDealsByBrandStmt: StatementSync;
  private recentDealsSinceStmt: StatementSync;
  private recentDealsByBrandSinceStmt: StatementSync;
  private staleListingsStmt: StatementSync;
  private countStaleStmt: StatementSync;
  private updateDerivedStmt: StatementSync;
  private hasDealStmt: StatementSync;
  private dealReasonsStmt: StatementSync;
  private deleteDealsForStmt: StatementSync;
  private deleteOldListingsStmt: StatementSync;
  private deleteOrphanDealsStmt: StatementSync;
  private markMissingStmt: StatementSync;
  private clearMissingForStmt: StatementSync;
  private clearAllMissingStmt: StatementSync;
  private countMissingStmt: StatementSync;
  private insertPriceEventStmt: StatementSync;
  private priceEventsForStmt: StatementSync;
  private currentPriceStmt: StatementSync;
  private deletePriceEventsForStmt: StatementSync;
  private brandVelocityStmt: StatementSync;
  private brandVelocityAllStmt: StatementSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();
    // v0.1 migration: condition column added after the bot shipped; listings
    // that predate it keep NULL and fall back to render-time extraction.
    const cols = this.db.prepare("PRAGMA table_info(listings)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "condition")) {
      this.db.exec("ALTER TABLE listings ADD COLUMN condition TEXT");
    }
    // subscriptions.size added with the per-channel size filter; existing rows
    // keep NULL (all sizes).
    const subCols = this.db
      .prepare("PRAGMA table_info(subscriptions)")
      .all() as Array<{ name: string }>;
    if (!subCols.some((c) => c.name === "size")) {
      this.db.exec("ALTER TABLE subscriptions ADD COLUMN size TEXT");
    }
    // Pipeline versioning: rows stamped with the version of the extraction
    // pipeline that produced them. 0 = pre-versioning (always stale).
    if (!cols.some((c) => c.name === "pipelineVersion")) {
      this.db.exec("ALTER TABLE listings ADD COLUMN pipelineVersion INTEGER NOT NULL DEFAULT 0");
    }
    const dealCols = this.db.prepare("PRAGMA table_info(deals)").all() as Array<{ name: string }>;
    if (!dealCols.some((c) => c.name === "pipelineVersion")) {
      this.db.exec("ALTER TABLE deals ADD COLUMN pipelineVersion INTEGER NOT NULL DEFAULT 0");
    }
    // Sold-velocity tracking: when a listing is last seen, and since when it
    // has been missing from complete poll rounds of its market. Operational
    // state (not a derived value) — deliberately no PIPELINE_VERSION bump.
    if (!cols.some((c) => c.name === "missingSince")) {
      this.db.exec("ALTER TABLE listings ADD COLUMN missingSince TEXT");
    }
    // The currency factor baked into priceUsd at ingest. Audit-only: reads
    // re-derive from native price so every value in a response shares the rate
    // in force now. Existing rows keep NULL ("vintage unknown").
    if (!cols.some((c) => c.name === "fxRate")) {
      this.db.exec("ALTER TABLE listings ADD COLUMN fxRate REAL");
    }
    // Price-event ledger: append-only history of listing prices. Written by
    // upsertListing on first sight and on every native-price move; an FX-rate
    // move alone never writes (the ledger tracks the market's price, not our
    // conversion table). Additive — nothing pre-existing reads it, so no
    // PIPELINE_VERSION bump.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS price_events (
        listingKey TEXT NOT NULL,
        at TEXT NOT NULL,
        price REAL NOT NULL,
        currency TEXT NOT NULL,
        priceUsd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_price_events_listing
        ON price_events (listingKey, at);
    `);

    this.hasStmt = this.db.prepare(
      "SELECT 1 AS one FROM listings WHERE market = ? AND marketId = ? LIMIT 1",
    );
    this.getStmt = this.db.prepare(
      "SELECT * FROM listings WHERE market = ? AND marketId = ? LIMIT 1",
    );
    this.upsertListingStmt = this.db.prepare(`
      INSERT INTO listings
        (key, market, marketId, title, brandKey, item, size, condition, price, currency, priceUsd,
         fxRate, url, imageUrl, endsAt, foundAt, updatedAt, pipelineVersion)
      VALUES
        (@key, @market, @marketId, @title, @brandKey, @item, @size, @condition, @price, @currency, @priceUsd,
         @fxRate, @url, @imageUrl, @endsAt, @foundAt, @updatedAt, @pipelineVersion)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title,
        brandKey = excluded.brandKey,
        item = excluded.item,
        size = excluded.size,
        condition = excluded.condition,
        price = excluded.price,
        currency = excluded.currency,
        priceUsd = excluded.priceUsd,
        fxRate = excluded.fxRate,
        url = excluded.url,
        imageUrl = excluded.imageUrl,
        endsAt = excluded.endsAt,
        updatedAt = excluded.updatedAt,
        pipelineVersion = excluded.pipelineVersion
    `);
    this.recentStmt = this.db.prepare(
      "SELECT * FROM listings WHERE updatedAt >= ? ORDER BY priceUsd DESC LIMIT 2000",
    );
    this.recentByBrandStmt = this.db.prepare(
      "SELECT * FROM listings WHERE brandKey = ? AND updatedAt >= ? ORDER BY priceUsd DESC LIMIT 500",
    );
    // The band is computed from the native price at the rate bound in, so the
    // rows selected agree with the rate the caller converts them at. Bucketing
    // on the stored column would filter at an ingest-time rate and then compare
    // at today's — a refresh could silently move a listing into or out of its
    // own comp set. `currency` is only ever JPY or USD (`Listing["currency"]`).
    this.recentByBrandRoundedStmt = this.db.prepare(
      `SELECT * FROM listings
       WHERE brandKey = ?
         AND ROUND((CASE WHEN currency = 'USD' THEN price ELSE price * ? END) / ?) * ? = ?
         AND updatedAt >= ?
       ORDER BY priceUsd DESC LIMIT 200`,
    );
    this.addSubStmt = this.db.prepare(`
      INSERT INTO subscriptions (guildId, channelId, watch, minScore, size)
      VALUES (@guildId, @channelId, @watch, @minScore, @size)
      ON CONFLICT(guildId, channelId, watch) DO UPDATE SET
        minScore = excluded.minScore,
        size = excluded.size
    `);
    this.deleteSubStmt = this.db.prepare(
      "DELETE FROM subscriptions WHERE guildId = ? AND channelId = ? AND watch = ?",
    );
    this.listSubStmt = this.db.prepare("SELECT * FROM subscriptions");
    this.setMetaStmt = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    this.getMetaStmt = this.db.prepare("SELECT value FROM meta WHERE key = ?");
    this.marketActivityStmt = this.db.prepare(
      "SELECT market, COUNT(*) AS rows24h, MAX(foundAt) AS latest FROM listings WHERE updatedAt >= ? GROUP BY market",
    );
    this.insertDealStmt = this.db.prepare(`
      INSERT INTO deals (listingKey, market, marketId, title, brandKey, priceUsd, url, reasons, score, foundAt, pipelineVersion)
      VALUES (@listingKey, @market, @marketId, @title, @brandKey, @priceUsd, @url, @reasons, @score, @foundAt, @pipelineVersion)
    `);
    this.staleListingsStmt = this.db.prepare(
      `SELECT * FROM listings WHERE pipelineVersion < ? ORDER BY foundAt LIMIT ?`,
    );
    this.countStaleStmt = this.db.prepare(
      "SELECT COUNT(*) AS c FROM listings WHERE pipelineVersion < ?",
    );
    this.updateDerivedStmt = this.db.prepare(
      "UPDATE listings SET brandKey = ?, size = ?, pipelineVersion = ? WHERE key = ?",
    );
    this.hasDealStmt = this.db.prepare("SELECT 1 AS one FROM deals WHERE listingKey = ? LIMIT 1");
    this.dealReasonsStmt = this.db.prepare("SELECT reasons FROM deals WHERE listingKey = ?");
    this.deleteDealsForStmt = this.db.prepare("DELETE FROM deals WHERE listingKey = ?");
    this.deleteOldListingsStmt = this.db.prepare("DELETE FROM listings WHERE updatedAt < ?");
    this.deleteOrphanDealsStmt = this.db.prepare(
      "DELETE FROM deals WHERE listingKey NOT IN (SELECT key FROM listings)",
    );
    this.markMissingStmt = this.db.prepare(
      "UPDATE listings SET missingSince = ? WHERE key = ? AND market = ? AND missingSince IS NULL",
    );
    this.clearMissingForStmt = this.db.prepare(
      "UPDATE listings SET missingSince = NULL WHERE key = ?",
    );
    this.clearAllMissingStmt = this.db.prepare("UPDATE listings SET missingSince = NULL");
    this.insertPriceEventStmt = this.db.prepare(
      "INSERT INTO price_events (listingKey, at, price, currency, priceUsd) VALUES (?, ?, ?, ?, ?)",
    );
    // rowid breaks same-millisecond ties (batched seeds share `at`).
    this.priceEventsForStmt = this.db.prepare(
      "SELECT at, price, currency, priceUsd FROM price_events WHERE listingKey = ? ORDER BY at, rowid",
    );
    this.currentPriceStmt = this.db.prepare(
      "SELECT price, currency FROM listings WHERE key = ?",
    );
    this.deletePriceEventsForStmt = this.db.prepare(
      "DELETE FROM price_events WHERE listingKey = ?",
    );
    this.brandVelocityStmt = this.db.prepare(
      `SELECT foundAt, missingSince FROM listings
       WHERE brandKey = ? ORDER BY foundAt DESC, rowid DESC LIMIT ?`,
    );
    // Per-brand last-N observations in one pass (window function, SQLite ≥3.25).
    this.brandVelocityAllStmt = this.db.prepare(
      `SELECT brandKey, foundAt, missingSince FROM (
         SELECT brandKey, foundAt, missingSince,
                ROW_NUMBER() OVER (PARTITION BY brandKey ORDER BY foundAt DESC, rowid DESC) AS rn
         FROM listings WHERE brandKey IS NOT NULL
       ) WHERE rn <= ?`,
    );
    this.countMissingStmt = this.db.prepare(
      "SELECT COUNT(*) AS c FROM listings WHERE missingSince IS NOT NULL",
    );
    // The native price + currency come along so the mapper can convert at the
    // rate in force now instead of the deal's ingest-time priceUsd.
    const DEAL_COLS = `d.*, l.imageUrl AS imageUrl, l.size AS size, l.condition AS condition,
         l.missingSince AS missingSince, l.price AS nativePrice, l.currency AS nativeCurrency`;

    this.recentDealsStmt = this.db.prepare(
      `SELECT ${DEAL_COLS}
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       ORDER BY d.foundAt DESC LIMIT ?`,
    );
    this.recentDealsByBrandStmt = this.db.prepare(
      `SELECT ${DEAL_COLS}
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       WHERE d.brandKey = ? ORDER BY d.foundAt DESC LIMIT ?`,
    );
    this.recentDealsSinceStmt = this.db.prepare(
      `SELECT ${DEAL_COLS}
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       WHERE d.foundAt >= ?
       ORDER BY d.foundAt DESC LIMIT ?`,
    );
    this.recentDealsByBrandSinceStmt = this.db.prepare(
      `SELECT ${DEAL_COLS}
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       WHERE d.brandKey = ? AND d.foundAt >= ? ORDER BY d.foundAt DESC LIMIT ?`,
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        key TEXT PRIMARY KEY,
        market TEXT NOT NULL,
        marketId TEXT NOT NULL,
        title TEXT NOT NULL,
        brandKey TEXT,
        item TEXT,
        size TEXT,
        price REAL NOT NULL,
        currency TEXT NOT NULL,
        priceUsd REAL NOT NULL,
        url TEXT NOT NULL,
        imageUrl TEXT,
        endsAt TEXT,
        foundAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_market_marketId
        ON listings (market, marketId);
      CREATE INDEX IF NOT EXISTS idx_listings_brand_updated
        ON listings (brandKey, updatedAt);
      CREATE INDEX IF NOT EXISTS idx_listings_updated ON listings (updatedAt);

      CREATE TABLE IF NOT EXISTS subscriptions (
        guildId TEXT NOT NULL,
        channelId TEXT NOT NULL,
        watch TEXT NOT NULL,
        minScore REAL NOT NULL DEFAULT 0,
        size TEXT,
        PRIMARY KEY (guildId, channelId, watch)
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        listingKey TEXT NOT NULL,
        market TEXT NOT NULL,
        marketId TEXT NOT NULL,
        title TEXT NOT NULL,
        brandKey TEXT,
        priceUsd REAL NOT NULL,
        url TEXT NOT NULL,
        reasons TEXT NOT NULL,
        score REAL NOT NULL,
        foundAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_deals_found ON deals (foundAt DESC);
    `);
  }

  // ── listings ─────────────────────────────────────────────────────────────
  has(market: MarketId, id: string): boolean {
    return this.hasStmt.get(market, id) !== undefined;
  }

  get(market: MarketId, id: string): StoredListing | undefined {
    const row = this.getStmt.get(market, id) as unknown as StoredListing | undefined;
    return row && withCurrentUsd(row, fxRatesSnapshot());
  }

  upsertListing(l: Listing): void {
    const now = new Date().toISOString();
    const key = `${l.market}:${l.id}`;
    const rates = fxRatesSnapshot();
    // Prior native price, read BEFORE the upsert overwrites it.
    const prior = this.currentPriceStmt.get(key) as
      | { price: number; currency: string }
      | undefined;
    this.upsertListingStmt.run({
      key,
      market: l.market,
      marketId: l.id,
      title: l.title,
      brandKey: l.brandKey ?? null,
      item: l.item ?? null,
      size: l.size ?? null,
      condition: l.condition ?? null,
      price: l.price,
      currency: l.currency,
      priceUsd: l.priceUsd,
      url: l.url,
      imageUrl: l.imageUrl ?? null,
      endsAt: l.endsAt ?? null,
      foundAt: l.foundAt,
      updatedAt: now,
      pipelineVersion: PIPELINE_VERSION,
      // Not round2 — this is a rate, not money: rounding 1/155 to cents
      // records 0.01 and makes the row's vintage unauditable.
      fxRate: usdFrom(1, l.currency, rates),
    });
    // Price-event ledger: a baseline event on first sight, then one per
    // native-price move. Pure FX moves never write (priceUsd recomputes
    // silently), so the ledger stays a market-price history:
    // two drops ⇒ exactly three events.
    if (!prior || prior.price !== l.price || prior.currency !== l.currency) {
      this.insertPriceEventStmt.run(key, now, l.price, l.currency, l.priceUsd);
    }
  }

  /** Append-only price history for one listing, oldest first. */
  priceEvents(listingKey: string): PriceEvent[] {
    return this.priceEventsForStmt.all(listingKey) as unknown as PriceEvent[];
  }

  /**
   * Gone-within-48h rate over a brand's last `n` sightings — the /velocity
   * metric. An observation "vanished within 48h" when it is currently absent
   * (missingSince set) and the absence began ≤48h after it was found. This is
   * brand-level churn: it never claims an individual piece sold.
   */
  brandVelocity(brandKey: string, n = 20): VelocityStat {
    const rows = this.brandVelocityStmt.all(brandKey, n) as unknown as Array<{
      foundAt: string;
      missingSince: string | null;
    }>;
    return velocityStat(rows);
  }

  /** Same stat for every brand with stored listings, in one query. */
  brandVelocityAll(n = 20): Map<string, VelocityStat> {
    const rows = this.brandVelocityAllStmt.all(n) as unknown as Array<{
      brandKey: string;
      foundAt: string;
      missingSince: string | null;
    }>;
    const byBrand = new Map<string, Array<{ foundAt: string; missingSince: string | null }>>();
    for (const r of rows) {
      const list = byBrand.get(r.brandKey);
      if (list) list.push({ foundAt: r.foundAt, missingSince: r.missingSince });
      else byBrand.set(r.brandKey, [{ foundAt: r.foundAt, missingSince: r.missingSince }]);
    }
    const out = new Map<string, VelocityStat>();
    for (const [brand, list] of byBrand) out.set(brand, velocityStat(list));
    return out;
  }

  recentListings(hours: number): StoredListing[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return this.convert(this.recentStmt.all(cutoff) as unknown as StoredListing[]);
  }

  recentByBrand(brandKey: string, hours: number): StoredListing[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return this.convert(this.recentByBrandStmt.all(brandKey, cutoff) as unknown as StoredListing[]);
  }

  /**
   * Rows of `brandKey` whose price falls in the same rounded band, converted at
   * the pinned `rates`. The caller passes the same set it used for the
   * candidate, so the filter and the values compared agree even if a refresh
   * lands mid-evaluation.
   */
  recentByBrandRounded(
    brandKey: string,
    roundUsd: number,
    roundedPrice: number,
    hours: number,
    rates: Readonly<Record<string, number>> = fxRatesSnapshot(),
  ): StoredListing[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const rows = this.recentByBrandRoundedStmt.all(
      brandKey,
      jpyUsdRate(rates),
      roundUsd,
      roundUsd,
      roundedPrice,
      cutoff,
    ) as unknown as StoredListing[];
    return rows.map((r) => withCurrentUsd(r, rates));
  }

  /** Convert a page of rows through one rate set. */
  private convert(rows: StoredListing[]): StoredListing[] {
    const rates = fxRatesSnapshot();
    return rows.map((r) => withCurrentUsd(r, rates));
  }

  // ── subscriptions ────────────────────────────────────────────────────────
  addSubscription(s: Subscription): void {
    this.addSubStmt.run({
      guildId: s.guildId,
      channelId: s.channelId,
      watch: s.watch,
      minScore: s.minScore,
      size: s.size ?? null,
    });
  }

  removeSubscription(guildId: string, channelId: string, watch: string): boolean {
    const res = this.deleteSubStmt.run(guildId, channelId, watch);
    return res.changes > 0;
  }

  listSubscriptions(): Subscription[] {
    return this.listSubStmt.all() as unknown as Subscription[];
  }

  subscriptionsFor(watch: string): Subscription[] {
    return (this.listSubStmt.all() as unknown as Subscription[]).filter(
      (s) => s.watch === watch || s.watch === "all",
    );
  }

  // ── deals ────────────────────────────────────────────────────────────────
  recordDeal(deal: Deal): void {
    const l = deal.listing;
    this.insertDealStmt.run({
      listingKey: `${l.market}:${l.id}`,
      market: l.market,
      marketId: l.id,
      title: l.title,
      brandKey: l.brandKey ?? null,
      priceUsd: l.priceUsd,
      url: l.url,
      reasons: JSON.stringify(deal.reasons),
      score: deal.score,
      foundAt: l.foundAt,
      pipelineVersion: PIPELINE_VERSION,
    });
  }

  /**
   * Swap a listing's deal for a fresh one: drop whatever rows it has, then
   * insert the new decision. A price drop is a new verdict on the same item,
   * not a second item — appending left two rows (two cards, two digest
   * entries, two alerts' worth of feed) for every listing that ever dropped.
   * Two statements, so a caller that needs the swap to be atomic wraps it in
   * a transaction, as the recompute pass does.
   */
  replaceDeal(deal: Deal): void {
    this.deleteDealsFor(`${deal.listing.market}:${deal.listing.id}`);
    this.recordDeal(deal);
  }

  /** Recent deals for watches (brand keys or "all"), newest first.
   *  `opts.brand` scopes the SQL to the brand so a niche brand is not starved
   *  out by the newest-N window (the dashboard filter relies on this).
   *  `opts.since` bounds the query in time — surfaces that document a window
   *  (finds ranking: 24h) must pass it, or high ingest shrinks their
   *  effective window to whatever the newest-N limit happens to cover. */
  recentDeals(watches: string[], limit: number, opts?: { brand?: string; since?: string }): Deal[] {
    const brand = opts?.brand;
    const since = opts?.since;
    type DealRow = {
      market: string;
      marketId: string;
      title: string;
      brandKey: string | null;
      priceUsd: number;
      url: string;
      reasons: string;
      score: number;
      foundAt: string;
      imageUrl: string | null;
      size: string | null;
      condition: string | null;
      missingSince: string | null;
      nativePrice: number | null;
      nativeCurrency: string | null;
    };
    const rates = fxRatesSnapshot();
    /** Today's USD value: from the native price when the listing is present,
     *  else the deal's own ingest-time value (an orphaned row). */
    const usdValue = (r: DealRow): number => {
      if (r.nativePrice === null || r.nativeCurrency === null) return r.priceUsd;
      try {
        return round2(usdFrom(r.nativePrice, r.nativeCurrency, rates));
      } catch {
        return r.priceUsd;
      }
    };
    const rows = (
      brand !== undefined && since !== undefined
        ? this.recentDealsByBrandSinceStmt.all(brand, since, limit)
        : brand !== undefined
          ? this.recentDealsByBrandStmt.all(brand, limit)
          : since !== undefined
            ? this.recentDealsSinceStmt.all(since, limit)
            : this.recentDealsStmt.all(limit)
    ) as unknown as DealRow[];
    const watchSet = new Set(watches);
    return rows
      .filter((r) => watchSet.has("all") || (r.brandKey !== null && watchSet.has(r.brandKey)))
      .slice(0, limit)
      .map((r) => {
        const priceUsd = usdValue(r);
        return {
          listing: {
            id: r.marketId,
            market: r.market as MarketId,
            title: r.title,
            brandKey: r.brandKey ?? undefined,
            price: priceUsd,
            currency: "USD" as const,
            priceUsd,
            url: r.url,
            foundAt: r.foundAt,
            imageUrl: r.imageUrl ?? undefined,
            size: r.size ?? undefined,
            condition: r.condition ?? undefined,
            // Attached for the sold-velocity surfaces; undefined ≡ live row.
            missingSince: r.missingSince ?? undefined,
          },
          proxy: proxyLinks({
            id: r.marketId,
            market: r.market as MarketId,
            title: r.title,
            price: priceUsd,
            currency: "USD",
            priceUsd,
            url: r.url,
            foundAt: r.foundAt,
          }),
          reasons: JSON.parse(r.reasons) as Deal["reasons"],
          score: r.score,
        };
      });
  }

  // ── pipeline recompute support ──────────────────────────────────────────

  /** Run `fn` inside a single write transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* no transaction open */
        /* eslint-disable-next-line */
      }
      throw err;
    }
  }

  staleListings(limit: number): StoredListing[] {
    return this.convert(
      this.staleListingsStmt.all(PIPELINE_VERSION, limit) as unknown as StoredListing[],
    );
  }

  countStale(): number {
    const row = this.countStaleStmt.get(PIPELINE_VERSION) as unknown as { c: number };
    return row.c;
  }

  /** Total listings, for logging context around recompute batches. */
  countListings(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM listings").get() as unknown as {
      c: number;
    };
    return row.c;
  }

  /** Policy-gated derived-value update for one listing row. */
  updateDerivedValues(key: string, brandKey: string | null, size: string | null): void {
    this.updateDerivedStmt.run(brandKey, size, PIPELINE_VERSION, key);
  }

  dealExistsFor(listingKey: string): boolean {
    return this.hasDealStmt.get(listingKey) !== undefined;
  }

  /** A deal's stored reasons, so a rebuild can carry forward the ones the
   *  engine cannot re-derive (a price drop is an observed event, not a value
   *  computed from the listing). Unreadable JSON reads as no reasons. */
  dealReasonsFor(listingKey: string): DealReason[] {
    const row = this.dealReasonsStmt.get(listingKey) as { reasons: string } | undefined;
    if (row === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(row.reasons);
      return Array.isArray(parsed) ? (parsed as DealReason[]) : [];
    } catch {
      return [];
    }
  }

  deleteDealsFor(listingKey: string): number {
    return Number(this.deleteDealsForStmt.run(listingKey).changes);
  }

  // ── retention ────────────────────────────────────────────────────────────

  /**
   * Delete listings not touched within the window, their deals (deals keep
   * their own denormalized foundAt, so match on listingKey), and any deals
   * orphaned by earlier prunes. One transaction — a crash can never leave a
   * deal pointing at a deleted listing.
   */
  pruneBefore(cutoff: string): { listings: number; deals: number } {
    return this.transaction(() => {
      const oldListings = this.db
        .prepare("SELECT key FROM listings WHERE updatedAt < ?")
        .all(cutoff) as unknown as Array<{ key: string }>;
      if (oldListings.length === 0) return { listings: 0, deals: 0 };
      const deleteDealsIn = this.db.prepare(
        `DELETE FROM deals WHERE listingKey IN (${oldListings.map(() => "?").join(",")})`,
      );
      const dChanges = Number(deleteDealsIn.run(...oldListings.map((r) => r.key)).changes);
      // The price ledger dies with its listing — no orphaned history.
      const deleteEventsIn = this.db.prepare(
        `DELETE FROM price_events WHERE listingKey IN (${oldListings.map(() => "?").join(",")})`,
      );
      deleteEventsIn.run(...oldListings.map((r) => r.key));
      this.deleteOldListingsStmt.run(cutoff);
      const oChanges = Number(
        this.deleteOrphanDealsStmt.run().changes, // sweep deals orphaned by earlier prunes
      );
      return { listings: oldListings.length, deals: dChanges + oChanges };
    });
  }

  /** Merge WAL into the main DB file after bulk deletes keep checkpoints short. */
  walCheckpoint(): void {
    // PASSIVE: never blocks readers; no-op when journal_mode is not WAL.
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE);");
  }

  // ── sold-velocity transitions ──────────────────────────────────────────────

  /**
   * Mark every currently-missing listing of `market` as missing since `at`.
   * Idempotent: rows already marked keep their original timestamp (the
   * missing-since must reflect the FIRST disappearance, not the latest tick).
   * Returns how many rows were newly marked.
   */
  markMissing(market: MarketId, at: string, keys: string[]): number {
    if (keys.length === 0) return 0;
    return this.transaction(() => {
      let marked = 0;
      for (const key of keys) {
        marked += Number(this.markMissingStmt.run(at, key, market).changes);
      }
      return marked;
    });
  }

  /** A previously-missing listing of `market` was seen again — clear it. */
  clearMissing(key: string): void {
    this.clearMissingForStmt.run(key);
  }

  /**
   * Record absent-since for keys that just went missing. Idempotent: rows
   * already missing keep their original timestamp (the label must age from
   * the FIRST absence, not churn each cycle). Reappearing rows are cleared
   * by clearMissing on sighting, not here.
   */
  applyAbsences(market: MarketId, at: string, absentKeys: string[]): number {
    let marked = 0;
    for (const key of absentKeys) {
      marked += Number(this.markMissingStmt.run(at, key, market).changes);
    }
    return marked;
  }

  /** Stored rows for the given brand keys (coverage-scoped absence checks). */
  listingsForBrands(brandKeys: string[]): StoredListing[] {
    if (brandKeys.length === 0) return [];
    const ph = brandKeys.map(() => "?").join(",");
    return this.convert(
      this.db
        .prepare(`SELECT * FROM listings WHERE brandKey IN (${ph})`)
        .all(...brandKeys) as unknown as StoredListing[],
    );
  }

  /** Total currently-missing rows (test/ops surface). */
  countMissing(): number {
    const row = this.countMissingStmt.get() as unknown as { c: number };
    return row.c;
  }

  /** Test seam: forget every transition (fresh start for a scenario). */
  resetMissing(): void {
    this.clearAllMissingStmt.run();
  }

  /**
   * Gone-now share per brand over that brand's stored listings — the
   * sell-through aggregate the finds factor consumes (and the shape ROADMAP
   * unit 4's /velocity command will reuse). Every stored row counts toward
   * its brand's denominator: a stock wiped out early keeps its high
   * gone-share even after the shelf empties.
   *
   * A brand with no fresh ingest inside `freshCutoffHours` is dropped
   * entirely — a paused or blocked market must not read as stellar
   * sell-through. Unbranded rows never pollute the aggregate.
   */
  sellThroughByBrand(
    freshCutoffHours = 24,
    now: number = Date.now(),
  ): Map<string, { gone: number; total: number; share: number }> {
    const freshCutoff = new Date(now - freshCutoffHours * 3_600_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT brandKey AS brand,
                COUNT(*) AS total,
                SUM(CASE WHEN missingSince IS NOT NULL THEN 1 ELSE 0 END) AS gone
         FROM listings
         WHERE brandKey IS NOT NULL
         GROUP BY brandKey`,
      )
      .all() as Array<{ brand: string; total: number; gone: number }>;
    const fresh = new Set(
      (
        this.db
          .prepare(
            `SELECT DISTINCT brandKey AS brand FROM listings
             WHERE brandKey IS NOT NULL AND updatedAt >= ?`,
          )
          .all(freshCutoff) as Array<{ brand: string }>
      ).map((r) => r.brand),
    );
    const out = new Map<string, { gone: number; total: number; share: number }>();
    for (const r of rows) {
      if (!fresh.has(r.brand)) continue;
      out.set(r.brand, { gone: r.gone, total: r.total, share: r.gone / r.total });
    }
    return out;
  }

  // ── market health ────────────────────────────────────────────────────────

  /**
   * Record the outcome of one market's query cycle (called by the poller at
   * cycle wrap). Ok means the fetch itself succeeded; queries/items describe
   * that cycle. Stored in the meta table under `round:<market>` keys.
   */
  recordMarketRound(market: MarketId, round: { at: string; ok: boolean; queries: number; items: number }): void {
    this.setMeta(`round:${market}:at`, round.at);
    this.setMeta(`round:${market}:ok`, round.ok ? "1" : "0");
    this.setMeta(`round:${market}:queries`, String(round.queries));
    this.setMeta(`round:${market}:items`, String(round.items));
  }

  /**
   * Per-market liveness for the dashboard status line and /status: when the
   * market last completed a query cycle, whether that cycle's fetch succeeded,
   * and how many listing rows it touched in the last 24h. A market with no
   * recorded round (disabled, never polled, or pre-feature data) reports nulls
   * rather than being mistaken for a working one.
   */
  marketHealth(now = Date.now()): MarketHealth[] {
    const since24h = new Date(now - 24 * 3600_000).toISOString();
    // Grouped in SQL, not piggybacked on recentListings — that reader caps at
    // 2000 price-sorted rows, which would undercount a healthy store.
    const counts = new Map<MarketId, { rows: number; latest: string | null }>();
    for (const r of this.marketActivityStmt.all(since24h) as unknown as Array<{
      market: MarketId;
      rows24h: number;
      latest: string | null;
    }>) {
      counts.set(r.market, { rows: Number(r.rows24h), latest: r.latest });
    }
    return ALL_MARKETS.map((market) => {
      const at = this.getMeta(`round:${market}:at`);
      return {
        market,
        lastRoundAt: at ? Date.parse(at) : null,
        lastRoundOk: at ? this.getMeta(`round:${market}:ok`) === "1" : null,
        lastRoundItems: at ? Number(this.getMeta(`round:${market}:items`) ?? 0) : null,
        rows24h: counts.get(market)?.rows ?? 0,
        latestListingAt: counts.get(market)?.latest ?? null,
      };
    });
  }

  // ── meta ─────────────────────────────────────────────────────────────────
  setMeta(key: string, value: string): void {
    this.setMetaStmt.run(key, value);
  }

  getMeta(key: string): string | undefined {
    const row = this.getMetaStmt.get(key) as unknown as { value: string } | undefined;
    return row?.value;
  }

  close(): void {
    this.db.close();
  }
}
