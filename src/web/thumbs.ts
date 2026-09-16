import { request } from "undici";
import { dispatcher } from "../core/http.js";

/**
 * Image CDNs the dashboard's thumbnail proxy may fetch from, by exact host.
 * Everything else is refused — the proxy fetches on behalf of browsers, so an
 * open proxy would be an SSRF door. Exact match only: no suffix/wildcard.
 */
const ALLOWED_HOSTS = new Set([
  "auc-pctr.c.yimg.jp", // Yahoo Auctions JP
  "static.mercdn.net", // Mercari JP
  "asset.fril.jp", // Rakuma
  "process.grailed.com", // Grailed
  "image.grailed.com", // Grailed (legacy asset host)
  "i.ebayimg.com", // eBay
]);

const MAX_BYTES = 2 * 1024 * 1024; // thumbnails are tens of KB; cap well above

export function isAllowedImageUrl(u: string): boolean {
  try {
    const url = new URL(u);
    if (url.username || url.password) return false; // no embedded credentials
    return url.protocol === "https:" && ALLOWED_HOSTS.has(url.host);
  } catch {
    return false;
  }
}

export interface Thumb {
  contentType: string;
  body: Buffer;
}

/** Fetch a whitelisted image over the shared h1-pinned dispatcher, size-capped. */
export async function fetchThumb(imageUrl: string): Promise<Thumb> {
  if (!isAllowedImageUrl(imageUrl)) throw new Error("image host not allowed");

  const res = await request(imageUrl, {
    dispatcher,
    headersTimeout: 8_000,
    bodyTimeout: 8_000,
  });
  if (res.statusCode !== 200) {
    res.body.dump(); // drain before discarding
    throw new Error(`thumb fetch → ${res.statusCode}`);
  }
  const rawType = res.headers["content-type"];
  const contentType = (Array.isArray(rawType) ? rawType[0] : rawType) ?? "";
  if (!contentType.startsWith("image/")) {
    res.body.dump();
    throw new Error(`unexpected content-type ${contentType || "none"}`);
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      res.body.destroy();
      throw new Error("thumb exceeds size cap");
    }
    chunks.push(chunk);
  }
  return { contentType, body: Buffer.concat(chunks) };
}
