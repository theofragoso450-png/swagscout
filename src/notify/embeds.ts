import type { Deal, Listing } from "../types.js";
import { MARKET_LABEL, MARKET_FLAG } from "../types.js";
import { getBrand } from "../config/brands.js";
import { safeUrl } from "../core/safe-url.js";
import { formatReason } from "../core/reasons.js";
import { formatUsd } from "../core/money.js";
import type { FindRank, VelocityMap } from "./finds.js";
import { FAST_MOVER_SHARE } from "./finds.js";

/** APIEmbed-compatible subset we build manually (no discord.js dependency here). */
export interface EmbedPayload {
  title: string;
  /** Optional: omitted when the listing URL fails the scheme allowlist. */
  url?: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

const COLOR_HIGH = 0x2ecc71; // green
const COLOR_MID = 0xe67e22; // orange
const COLOR_LOW = 0x3498db; // blue

function colorFor(score: number): number {
  if (score >= 70) return COLOR_HIGH;
  if (score >= 45) return COLOR_MID;
  return COLOR_LOW;
}

/** Honesty label for a missing listing: absence is not proof of sale. */
function missingForLabel(mins: number): string {
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const span = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `Sold or delisted · ${span} ago`;
}

const FIELD_MAX = 1024; // Discord embed field value cap

/** Marketplace-controlled text must not render as markdown inside fields. */
function esc(s: string): string {
  return s.replace(/[\\`*_~\[\]()<>|\n\r]/g, (c) => (c === "\n" || c === "\r" ? " " : `\\${c}`));
}

/** Escape, then cap: overflow is dropped, never left unescaped. */
function bounded(s: string, max: number): string {
  const escaped = esc(s);
  return escaped.length <= max ? escaped : escaped.slice(0, max - 1) + "…";
}

export function buildDealEmbed(deal: Deal): EmbedPayload {
  const l: Listing = deal.listing;
  const brandName = l.brandKey ? getBrand(l.brandKey)?.name ?? l.brandRaw : l.brandRaw;
  const flag = MARKET_FLAG[l.market];

  const priceLine =
    l.currency === "JPY"
      ? `¥${l.price.toLocaleString("en-US")} ≈ ${formatUsd(l.priceUsd)}`
      : formatUsd(l.priceUsd);

  const reasons = deal.reasons.map((r) => `• ${formatReason(r, l.priceUsd)}`).join("\n");

  const proxyParts: string[] = [];
  if (deal.proxy.buyee) proxyParts.push(`[Buyee](${deal.proxy.buyee})`);
  if (deal.proxy.zenmarket) proxyParts.push(`[ZenMarket](${deal.proxy.zenmarket})`);
  if (deal.proxy.sendico) proxyParts.push(`[Sendico](${deal.proxy.sendico})`);
  const proxyValue =
    proxyParts.length > 0 ? proxyParts.join(" • ") : "_direct listing (no proxy needed)_";

  const fields: EmbedPayload["fields"] = [
    { name: "Price", value: `${flag} ${priceLine}`, inline: true },
    { name: "Market", value: MARKET_LABEL[l.market], inline: true },
  ];
  if (brandName) fields.push({ name: "Brand", value: bounded(brandName, FIELD_MAX), inline: true });
  if (l.size) fields.push({ name: "Size", value: bounded(l.size, FIELD_MAX), inline: true });
  if (l.endsAt) {
    const ts = Math.floor(Date.parse(l.endsAt) / 1000);
    if (Number.isFinite(ts) && ts > Date.now() / 1000) {
      fields.push({ name: "Auction ends", value: `<t:${ts}:R>`, inline: true });
    }
  }
  if (l.missingSince) {
    const mins = Math.round((Date.now() - Date.parse(l.missingSince)) / 60_000);
    if (Number.isFinite(mins) && mins >= 0) {
      fields.push({ name: "Status", value: bounded(missingForLabel(mins), FIELD_MAX), inline: true });
    }
  }
  fields.push({ name: "Why it's a deal", value: reasons.slice(0, 1000) });
  fields.push({ name: "Proxy buy", value: proxyValue });

  const thumb = safeUrl(l.imageUrl);
  return {
    title: l.title.slice(0, 250),
    url: safeUrl(l.url) ?? undefined,
    color: colorFor(deal.score),
    fields,
    thumbnail: thumb ? { url: thumb } : undefined,
    footer: { text: `SwagScout • score ${deal.score}` },
    timestamp: l.foundAt,
  };
}

export function buildDealEmbeds(deals: Deal[]): EmbedPayload[] {
  return deals.map(buildDealEmbed);
}

/** Deal embed decorated with the find's rank, rarity tier, and finds score. */
export function buildFindEmbeds(
  finds: FindRank[],
  velocity?: VelocityMap,
): EmbedPayload[] {
  return finds.map((f) => {
    const base = buildDealEmbed(f.deal);
    const brand = f.deal.listing.brandKey;
    const share = brand ? (velocity?.get(brand)?.share ?? 0) : 0;
    return {
      ...base,
      fields: [
        { name: "Find", value: `#${f.rank} · ${f.rarity}-tier`, inline: true },
        { name: "Finds score", value: String(f.findsScore), inline: true },
        ...(share >= FAST_MOVER_SHARE
          ? [{ name: "Velocity", value: "⚡ Fast mover — pieces like this stop being listed soon", inline: false }]
          : []),
        ...base.fields,
      ],
    };
  });
}
