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
  };
}

/** Ensure data dir exists for SQLite. */
export function ensureDbDir(env: Env): void {
  const dir = path.dirname(env.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
