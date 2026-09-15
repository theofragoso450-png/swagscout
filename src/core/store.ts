import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Deal, Listing, MarketId } from "../types.js";
import { proxyLinks } from "../proxy/links.js";

export interface StoredListing {
  key: string; // `${market}:${id}`
  market: MarketId;
  marketId: string;
  title: string;
  brandKey: string | null;
  item: string | null;
  size: string | null;
  price: number;
  currency: string;
  priceUsd: number;
  url: string;
  imageUrl: string | null;
  endsAt: string | null;
  foundAt: string;
  updatedAt: string;
}

export interface Subscription {
  guildId: string;
  channelId: string;
  /** brand key or "all" */
  watch: string;
  /** minimum deal score to alert in this channel */
  minScore: number;
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

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.migrate();

    this.hasStmt = this.db.prepare(
      "SELECT 1 AS one FROM listings WHERE market = ? AND marketId = ? LIMIT 1",
    );
    this.getStmt = this.db.prepare(
      "SELECT * FROM listings WHERE market = ? AND marketId = ? LIMIT 1",
    );
    this.upsertListingStmt = this.db.prepare(`
      INSERT INTO listings
        (key, market, marketId, title, brandKey, item, size, price, currency, priceUsd,
         url, imageUrl, endsAt, foundAt, updatedAt)
      VALUES
        (@key, @market, @marketId, @title, @brandKey, @item, @size, @price, @currency, @priceUsd,
         @url, @imageUrl, @endsAt, @foundAt, @updatedAt)
      ON CONFLICT(key) DO UPDATE SET
        title = excluded.title,
        brandKey = excluded.brandKey,
        item = excluded.item,
        size = excluded.size,
        price = excluded.price,
        currency = excluded.currency,
        priceUsd = excluded.priceUsd,
        url = excluded.url,
        imageUrl = excluded.imageUrl,
        endsAt = excluded.endsAt,
        updatedAt = excluded.updatedAt
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
      INSERT INTO subscriptions (guildId, channelId, watch, minScore)
      VALUES (@guildId, @channelId, @watch, @minScore)
      ON CONFLICT(guildId, channelId, watch) DO UPDATE SET minScore = excluded.minScore
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
      INSERT INTO deals (listingKey, market, marketId, title, brandKey, priceUsd, url, reasons, score, foundAt)
      VALUES (@listingKey, @market, @marketId, @title, @brandKey, @priceUsd, @url, @reasons, @score, @foundAt)
    `);
    this.recentDealsStmt = this.db.prepare(
      "SELECT * FROM deals ORDER BY foundAt DESC LIMIT ?",
    );
    this.recentDealsByBrandStmt = this.db.prepare(
      "SELECT * FROM deals WHERE brandKey = ? ORDER BY foundAt DESC LIMIT ?",
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
      price: l.price,
      currency: l.currency,
      priceUsd: l.priceUsd,
      url: l.url,
      imageUrl: l.imageUrl ?? null,
      endsAt: l.endsAt ?? null,
      foundAt: l.foundAt,
      updatedAt: now,
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
    });
  }

  /** Recent deals for watches (brand keys or "all"), newest first.
   *  When `brand` is set, query brand-scoped so a niche brand is not starved
   *  out by the newest-N window (the dashboard filter relies on this). */
  recentDeals(watches: string[], limit: number, brand?: string): Deal[] {
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
    };
    const rows = (
      brand !== undefined
        ? this.recentDealsByBrandStmt.all(brand, limit)
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
