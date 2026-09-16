import type { MarketId, Listing } from "../types.js";
import { matchBrand } from "../config/brands.js";
import { toUsd } from "./fx.js";

/**
 * Normalize raw listing data into the canonical Listing shape:
 * brand matching, item cleanup, size extraction, currency conversion.
 */

export interface RawListingInput {
  id: string;
  market: MarketId;
  title: string;
  price: number;
  currency: "JPY" | "USD";
  url: string;
  imageUrl?: string;
  endsAt?: string;
  size?: string;
}

const NOISE_WORDS = [
  "中古",
  "美品",
  "送料",
  "送料無料",
  "即購入可",
  "値下げ",
  "最終値下げ",
  "着払い",
  "used",
  "authentic",
  "deadstock",
  "flawless",
];

export function extractSize(title: string): string | undefined {
  // Match common size notations: S/M/L/XL, 1-7, W30, 28, "サイズM" etc.
  const patterns = [
    /\b(x{0,2}s|m|l|x{1,3}l|xxl)\b/i,
    /\b[1-7]\b/,
    /\bw(?:aist)?\s?\d{2}\b/i,
    /\b\d{2}(?:\.\d)?\b(?=\s*(?:cm|inch)?)/,
  ];
  for (const p of patterns) {
    const m = title.match(p);
    if (m) return m[0].trim().toUpperCase();
  }
  return undefined;
}

/**
 * Normalize a listing's condition from the marketplace's own title markers
 * (titles are the only structured condition signal this bot has). Returns
 * undefined when no known marker is present. Runs on the RAW title at
 * ingest — cleanTitle() deliberately strips these words as noise.
 */
export function extractCondition(title: string): string | undefined {
  const t = title.toLowerCase();
  if (/新品同様|未使用品?|deadstock|\bun-?used\b|never\s+(?:been\s+)?used/.test(t)) return "new";
  if (/美品|良品|near mint|excellent/.test(t)) return "like-new";
  // "un-used"/"unused" must not degrade to "used" — hence the lookbehind.
  if (/(?<!un)\bused\b|中古|pre-?owned/.test(t)) return "used";
  return undefined;
}

export function cleanTitle(title: string): string {
  let t = title.trim();
  for (const w of NOISE_WORDS) {
    t = t.split(w).join(" ");
  }
  return t.replace(/\s{2,}/g, " ").trim();
}

export function normalizeListing(raw: RawListingInput): Listing {
  const brand = matchBrand(raw.title);
  const priceUsd = toUsd(raw.price, raw.currency);
  return {
    id: raw.id,
    market: raw.market,
    title: cleanTitle(raw.title),
    brandKey: brand?.brandKey,
    brandRaw: brand?.matched,
    item: undefined,
    size: raw.size ?? extractSize(raw.title),
    condition: extractCondition(raw.title),
    endsAt: raw.endsAt,
    price: raw.price,
    currency: raw.currency,
    priceUsd: Math.round(priceUsd * 100) / 100,
    url: raw.url,
    imageUrl: raw.imageUrl,
    foundAt: new Date().toISOString(),
  };
}

/**
 * Canonical item key used for cross-market comp matching:
 * lowercase brand slug + significant title tokens (model/season/size hints).
 */
export function canonicalKey(l: Listing): string {
  const brand = l.brandKey ?? "unknown";
  const stop = new Set([
    "the", "and", "for", "men", "mens", "women", "womens", "hommes", "femme", "homme",
    ...NOISE_WORDS,
  ]);
  const tokens = cleanTitle(l.title)
    .toLowerCase()
    .replace(/[^a-z0-9ぁ-んァ-ヶー一-龠\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !stop.has(t) && !/^\d+$/.test(t));
  return `${brand}|${tokens.slice(0, 8).join(" ")}`;
}

/** Compact key for grouping prices: brand + rounded USD price. */
export function roundTo(n: number, step: number): number {
  return Math.round(n / step) * step;
}
