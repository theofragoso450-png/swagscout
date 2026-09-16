import type { Deal, Listing } from "../types.js";
import { MARKET_LABEL, MARKET_FLAG } from "../types.js";
import { getBrand } from "../config/brands.js";
import { safeUrl } from "../core/safe-url.js";

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

function fmtUsd(n: number): string {
  return `$${n.toFixed(2).replace(/\.00$/, "")}`;
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
    l.currency === "JPY" ? `¥${l.price.toLocaleString("en-US")} ≈ ${fmtUsd(l.priceUsd)}` : fmtUsd(l.priceUsd);

  const reasons = deal.reasons.map((r) => `• ${r.detail}`).join("\n");

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
