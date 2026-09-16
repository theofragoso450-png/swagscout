import type { Listing, ProxyLinks } from "../types.js";

/**
 * Proxy-shopping links attached to every JP listing (SwagSearch-style).
 * Each service has a stable URL scheme keyed off the source URL.
 */

const YAHOO_AUCTION_RE = /auctions\.yahoo\.co\.jp\/(?:jp\/)?auction\/([a-z0-9]+)/i;

export function proxyLinks(listing: Listing): ProxyLinks {
  const links: ProxyLinks = {};

  const yahoo = listing.url.match(YAHOO_AUCTION_RE);
  if (yahoo) {
    const id = yahoo[1]!;
    links.buyee = `https://buyee.jp/item/yahoo/auction/${id}`;
    links.zenmarket = `https://zenmarket.jp/en/auction.aspx?itemCode=${id}`;
    links.sendico = `https://sendico.yahoo.co.jp/auctions/jp/item/${id}`;
    return links;
  }

  // Mercari & Rakuma: proxy services key off the numeric listing id. Only
  // alphanumeric ids are interpolated — marketplace-controlled ids that carry
  // URL-breaking characters must not reach proxy URL templates.
  if (!/^[a-zA-Z0-9]+$/.test(listing.id)) return links;
  if (listing.market === "mercari") {
    links.buyee = `https://buyee.jp/mercari/purchase/${listing.id}`;
    links.zenmarket = `https://zenmarket.jp/en/mercari/product.aspx?code=${listing.id}`;
  }
  if (listing.market === "rakuma") {
    links.buyee = `https://buyee.jp/rakuma/purchase/${listing.id}`;
  }

  return links;
}
