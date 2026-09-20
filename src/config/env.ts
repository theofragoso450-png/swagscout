import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

export type MarketId = "yahoo" | "grailed" | "ebay" | "mercari" | "rakuma";

export const MARKET_IDS: MarketId[] = ["yahoo", "grailed", "ebay", "mercari", "rakuma"];

function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function opt(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

function clampHour(raw: string | undefined): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n >= 24 || !Number.isInteger(n)) return undefined;
  return n;
}

/** Retention window in days; RETENTION_DAYS=0 disables. Default 30. */
function parseRetentionDays(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

/** Live FX refresh cadence in hours; 0 keeps the static table. Default 24. */
function parseFxRefreshHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 24;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

function parseList(name: string): string[] {
  const v = opt(name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export interface Env {
  discordToken?: string;
  discordWebhookUrl?: string;
  discordAllowedChannels: string[];
  ebayAppId?: string;
  ebayCertId?: string;
  watchKeys: string[];
  pollSeconds: Record<MarketId, number>;
  compRoundUsd: number;
  rateLimitRpm: number;
  playwrightExecutablePath?: string;
  port: number;
  dbPath: string;
  /** Local hour (0-23) for the daily finds digest; undefined = disabled. */
  digestHour?: number;
  /** Retention window in days for listings + deals; 0 disables pruning. */
  retentionDays: number;
  /** Live FX refresh cadence in hours — a duration, not a wall-clock hour, so
   *  unlike DIGEST_HOUR_JST it carries no timezone suffix. Default 24; 0 keeps
   *  the built-in static table (the same zero-means-off idiom as
   *  RETENTION_DAYS). The last good snapshot is cached in the store and is
   *  re-served when a fetch fails, so the static table is only reached on a
   *  database that has never held a snapshot. */
  fxRefreshHours: number;
}

export function loadEnv(): Env {
  return {
    discordToken: opt("DISCORD_TOKEN"),
    discordWebhookUrl: opt("DISCORD_WEBHOOK_URL"),
    discordAllowedChannels: parseList("DISCORD_ALLOWED_CHANNELS"),
    ebayAppId: opt("EBAY_APP_ID"),
    ebayCertId: opt("EBAY_CERT_ID"),
    watchKeys: parseList("SWAGSCOUT_WATCH"),
    pollSeconds: {
      yahoo: num("POLL_YAHOO", 30),
      grailed: num("POLL_GRAILED", 45),
      ebay: num("POLL_EBAY", 60),
      mercari: num("POLL_MERCARI", 90),
      rakuma: num("POLL_RAKUMA", 90),
    },
    compRoundUsd: num("COMP_ROUND_USD", 50),
    rateLimitRpm: num("RATE_LIMIT_RPM", 12),
    playwrightExecutablePath: opt("PLAYWRIGHT_EXECUTABLE_PATH"),
    // Dashboard bind port (and the health endpoint Docker's healthcheck polls).
    port: num("PORT", 3080),
    dbPath: opt("DB_PATH") ?? path.join(process.cwd(), "data", "swagscout.db"),
    // Daily finds digest: set DIGEST_HOUR_JST=8 for 08:00 JST; unset = off.
    digestHour: opt("DIGEST_HOUR_JST") === undefined ? undefined : clampHour(opt("DIGEST_HOUR_JST")),
    // Nightly retention: prune listings (and their deals) older than this.
    retentionDays: parseRetentionDays(process.env.RETENTION_DAYS),
    // Live FX refresh cadence: hours between rate refreshes; 0 = static only.
    fxRefreshHours: parseFxRefreshHours(process.env.FX_REFRESH_HOURS),
  };
}

/** Ensure data dir exists for SQLite. */
export function ensureDbDir(env: Env): void {
  const dir = path.dirname(env.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
