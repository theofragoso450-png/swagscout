import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Deal, Listing, MarketId } from "../types.js";
import { proxyLinks } from "../proxy/links.js";
import { PIPELINE_VERSION } from "./pipeline.js";

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
  private insertDealStmt: StatementSync;
  private recentDealsStmt: StatementSync;
  private recentDealsByBrandStmt: StatementSync;
  private recentDealsSinceStmt: StatementSync;
  private recentDealsByBrandSinceStmt: StatementSync;
  private staleListingsStmt: StatementSync;
  private countStaleStmt: StatementSync;
  private updateDerivedStmt: StatementSync;
  private hasDealStmt: StatementSync;
  private deleteDealsForStmt: StatementSync;
  private deleteOldListingsStmt: StatementSync;
  private deleteOrphanDealsStmt: StatementSync;
  private markMissingStmt: StatementSync;
  private clearMissingForStmt: StatementSync;
  private clearAllMissingStmt: StatementSync;
  private countMissingStmt: StatementSync;

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

    this.hasStmt = this.db.prepare(
      "SELECT 1 AS one FROM listings WHERE market = ? AND marketId = ? LIMIT 1",
    );
    this.getStmt = this.db.prepare(
      "SELECT * FROM listings WHERE market = ? AND marketId = ? LIMIT 1",
    );
    this.upsertListingStmt = this.db.prepare(`
      INSERT INTO listings
        (key, market, marketId, title, brandKey, item, size, condition, price, currency, priceUsd,
         url, imageUrl, endsAt, foundAt, updatedAt, pipelineVersion)
      VALUES
        (@key, @market, @marketId, @title, @brandKey, @item, @size, @condition, @price, @currency, @priceUsd,
         @url, @imageUrl, @endsAt, @foundAt, @updatedAt, @pipelineVersion)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title,
        brandKey = excluded.brandKey,
        item = excluded.item,
        size = excluded.size,
        condition = excluded.condition,
        price = excluded.price,
        currency = excluded.currency,
        priceUsd = excluded.priceUsd,
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
    this.recentByBrandRoundedStmt = this.db.prepare(
      `SELECT * FROM listings
       WHERE brandKey = ? AND ROUND(priceUsd / ?) * ? = ? AND updatedAt >= ?
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
    this.countMissingStmt = this.db.prepare(
      "SELECT COUNT(*) AS c FROM listings WHERE missingSince IS NOT NULL",
    );
    this.recentDealsStmt = this.db.prepare(
      `SELECT d.*, l.imageUrl AS imageUrl, l.size AS size, l.condition AS condition, l.missingSince AS missingSince
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       ORDER BY d.foundAt DESC LIMIT ?`,
    );
    this.recentDealsByBrandStmt = this.db.prepare(
      `SELECT d.*, l.imageUrl AS imageUrl, l.size AS size, l.condition AS condition, l.missingSince AS missingSince
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       WHERE d.brandKey = ? ORDER BY d.foundAt DESC LIMIT ?`,
    );
    this.recentDealsSinceStmt = this.db.prepare(
      `SELECT d.*, l.imageUrl AS imageUrl, l.size AS size, l.condition AS condition, l.missingSince AS missingSince
       FROM deals d LEFT JOIN listings l ON l.key = d.listingKey
       WHERE d.foundAt >= ?
       ORDER BY d.foundAt DESC LIMIT ?`,
    );
    this.recentDealsByBrandSinceStmt = this.db.prepare(
      `SELECT d.*, l.imageUrl AS imageUrl, l.size AS size, l.condition AS condition, l.missingSince AS missingSince
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
    return this.getStmt.get(market, id) as unknown as StoredListing | undefined;
  }

  upsertListing(l: Listing): void {
    const now = new Date().toISOString();
    this.upsertListingStmt.run({
      key: `${l.market}:${l.id}`,
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
    });
  }

  recentListings(hours: number): StoredListing[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return this.recentStmt.all(cutoff) as unknown as StoredListing[];
  }

  recentByBrand(brandKey: string, hours: number): StoredListing[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return this.recentByBrandStmt.all(brandKey, cutoff) as unknown as StoredListing[];
  }

  recentByBrandRounded(
    brandKey: string,
    roundUsd: number,
    roundedPrice: number,
    hours: number,
  ): StoredListing[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return this.recentByBrandRoundedStmt.all(
      brandKey,
      roundUsd,
      roundUsd,
      roundedPrice,
      cutoff,
    ) as unknown as StoredListing[];
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
      .map((r) => ({
        listing: {
          id: r.marketId,
          market: r.market as MarketId,
          title: r.title,
          brandKey: r.brandKey ?? undefined,
          price: r.priceUsd,
          currency: "USD" as const,
          priceUsd: r.priceUsd,
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
          price: r.priceUsd,
          currency: "USD",
          priceUsd: r.priceUsd,
          url: r.url,
          foundAt: r.foundAt,
        }),
        reasons: JSON.parse(r.reasons) as Deal["reasons"],
        score: r.score,
      }));
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
    return this.staleListingsStmt.all(PIPELINE_VERSION, limit) as unknown as StoredListing[];
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
    return this.db
      .prepare(`SELECT * FROM listings WHERE brandKey IN (${ph})`)
      .all(...brandKeys) as unknown as StoredListing[];
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
