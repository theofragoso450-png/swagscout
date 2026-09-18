import Fastify from "fastify";
import type { Store } from "../core/store.js";
import { ALL_MARKETS, MARKET_LABEL } from "../types.js";
import { BRANDS } from "../config/brands.js";
import { THRESHOLD_RULES } from "../config/rules.js";
import type { Deal } from "../types.js";
import { fetchThumb, isAllowedImageUrl } from "./thumbs.js";
import { extractCondition } from "../core/normalize.js";
import { rankFinds } from "../notify/finds.js";

const CONDITION_LABEL: Record<string, string> = {
  new: "New",
  "like-new": "Like new",
  used: "Used",
};

/**
 * Marketplace-controlled URLs must never reach the page with an executable
 * scheme; non-http(s) or unparseable values are nulled and render inert ("#").
 */
function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

const PAGE = `
<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>SwagScout — archive fashion deals</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0d1117; color:#e6edf3; }
  header { padding:18px 24px; border-bottom:1px solid #21262d; display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; letter-spacing:.5px; }
  h1 span { color:#3fb950; }
  .sub { color:#8b949e; font-size:13px; }
  .bar { padding:12px 24px; display:flex; gap:8px; flex-wrap:wrap; border-bottom:1px solid #21262d; }
  select, input { background:#161b22; color:#e6edf3; border:1px solid #30363d; border-radius:6px; padding:6px 10px; font-size:13px; }
  main { padding: 16px 24px; }
  .deal { border:1px solid #21262d; border-radius:10px; padding:12px 14px; margin-bottom:10px; display:flex; gap:14px; background:#161b22; }
  .deal img { width:72px; height:72px; object-fit:cover; border-radius:8px; background:#21262d; }
  .meta { flex:1; min-width:0; }
  .title { font-weight:600; font-size:14px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .title a { color:#e6edf3; text-decoration:none; }
  .title a:hover { color:#58a6ff; }
  .row { font-size:12px; color:#8b949e; margin-top:4px; display:flex; gap:10px; flex-wrap:wrap; }
  .badge { background:#21262d; border-radius:999px; padding:1px 8px; font-size:11px; }
  .score { color:#3fb950; font-weight:700; }
  .badge.size { color:#79c0ff; }
  .badge.cond-new { color:#3fb950; }
  .badge.cond-like-new { color:#d29922; }
  .badge.cond-used { color:#8b949e; }
  .reasons { font-size:12px; color:#d29922; margin-top:4px; }
  .proxies a { color:#58a6ff; font-size:12px; margin-right:8px; text-decoration:none; }
  .empty { color:#8b949e; padding:32px 0; text-align:center; }
  .finds-head { font-size:15px; font-weight:700; margin:18px 0 10px; }
  .tier { border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; margin-right:8px; }
  .tier-S { background:#1f6feb; color:#ffffff; }
  .tier-A { background:#238636; color:#ffffff; }
  .tier-B { background:#9e6a03; color:#ffffff; }
  .tier-C { background:#30363d; color:#c9d1d9; }
  .finds-empty { color:#8b949e; font-size:13px; margin:10px 0 4px; }
</style>
</head>
<body>
<header>
  <h1>Swag<span>Scout</span></h1>
  <div class="sub" id="stats">loading…</div>
</header>
<div class="bar">
  <select id="market"><option value="">All markets</option></select>
  <select id="brand"><option value="">All brands</option></select>
  <select id="size"><option value="">All sizes</option></select>
  <select id="sort">
    <option value="found">Newest</option>
    <option value="score">Best score</option>
    <option value="price">Lowest price</option>
  </select>
  <input id="q" type="search" placeholder="Filter titles…">
</div>
<section id="finds"></section>
<main id="feed"><div class="empty">No deals yet — the poller is warming up.</div></main>
<script>
  const markets = ${JSON.stringify(ALL_MARKETS.map((m) => ({ id: m, label: MARKET_LABEL[m] })))};
  const brands = ${JSON.stringify(BRANDS.map((b) => ({ key: b.key, name: b.name })))};
  const conditionLabels = ${JSON.stringify(CONDITION_LABEL)};
  for (const m of markets) {
    document.getElementById("market").insertAdjacentHTML("beforeend", \`<option value="\${m.id}">\${m.label}</option>\`);
  }
  for (const b of brands) {
    document.getElementById("brand").insertAdjacentHTML("beforeend", \`<option value="\${b.key}">\${b.name}</option>\`);
  }
  const sizeSel = document.getElementById("size");
  async function rebuildSizeOptions() {
    const keep = sizeSel.value;
    const res = await fetch("/api/sizes");
    const sizes = await res.json();
    sizeSel.innerHTML = '<option value="">All sizes</option>' +
      sizes.map((s) => \`<option value="\${escapeHtml(s)}">\${escapeHtml(s)}</option>\`).join("");
    if ([...sizeSel.options].some((o) => o.value === keep)) sizeSel.value = keep;
    else sizeSel.value = "";
  }
  rebuildSizeOptions();
  setInterval(rebuildSizeOptions, 60000);
  async function loadFinds() {
    const res = await fetch("/api/finds");
    const data = await res.json();
    const el = document.getElementById("finds");
    if (!data.finds.length) {
      el.innerHTML = '<h2 class="finds-head">Finds of the day</h2>' +
        '<div class="finds-empty">No comp-backed finds in the last 24h — deals with a cross-market comp ("X% below N-listing median") rank here.</div>';
      return;
    }
    el.innerHTML = '<h2 class="finds-head">Finds of the day</h2>' + data.finds.map(render).join("");
  }
  loadFinds();
  setInterval(loadFinds, 60000);
  let timer;
  async function refresh() {
    const p = new URLSearchParams();
    const m = document.getElementById("market").value;
    const b = document.getElementById("brand").value;
    const z = sizeSel.value;
    const s = document.getElementById("sort").value;
    const q = document.getElementById("q").value;
    if (m) p.set("market", m);
    if (b) p.set("brand", b);
    if (z) p.set("size", z);
    if (s) p.set("sort", s);
    if (q) p.set("q", q);
    const res = await fetch("/api/deals?" + p.toString());
    const data = await res.json();
    const feed = document.getElementById("feed");
    if (!data.deals.length) { feed.innerHTML = '<div class="empty">No deals match.</div>'; }
    else feed.innerHTML = data.deals.map(render).join("");
    document.getElementById("stats").textContent = data.stats;
  }
  // Marketplace-controlled URLs (listing + proxy links) must never carry an
  // executable scheme; anything not resolving to http(s) renders inert ("#").
  function safeUrl(u) {
    if (!u) return "#";
    try {
      const parsed = new URL(u, location.origin);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "#";
      return parsed.href;
    } catch { return "#"; }
  }
  function render(d) {
    const isFind = d.rank != null;
    const reasons = (d.reasons||[]).filter(r => !isFind || r.kind === "comp").map(r => "• " + r.detail).join(" &nbsp; ");
    const proxies = Object.entries(d.proxy||{}).map(([k,v]) => \`<a href="\${escapeHtml(safeUrl(v))}" target="_blank">\${escapeHtml(k[0].toUpperCase()+k.slice(1))}</a>\`).join("");
    return \`<div class="deal">
      \${d.imageUrl ? \`<img src="\${escapeHtml(safeUrl(d.imageUrl))}" loading="lazy" onerror="this.onerror=null;this.src='data:image/gif;base64,R0lGODlhAQABAAAAACw='">\` : "<img src='data:image/gif;base64,R0lGODlhAQABAAAAACw=' >"}
      <div class="meta">
        <div class="title">\${d.rank != null ? \`<span class="tier tier-\${escapeHtml(d.tier)}">\${escapeHtml(d.findLabel)}</span>\` : ""}<a href="\${escapeHtml(safeUrl(d.url))}" target="_blank">\${escapeHtml(d.title)}</a></div>
        <div class="row">
          <span class="badge">\${escapeHtml(d.marketLabel)}</span>
          \${d.size ? \`<span class="badge size">\${escapeHtml(d.size)}</span>\` : ""}
          \${!isFind && d.condition ? \`<span class="badge cond cond-\${escapeHtml(d.condition)}">\${escapeHtml(conditionLabels[d.condition] || d.condition)}</span>\` : ""}
          <span>\${d.priceLabel}</span>
          <span class="score">score \${d.score}</span>
          \${!isFind && d.endsInMin != null && d.endsInMin > 0 ? \`<span>ends in \${fmtDur(d.endsInMin)}</span>\` : ""}
        </div>
        <div class="reasons">\${reasons}</div>
        <div class="proxies">\${proxies}</div>
      </div>
    </div>\`;
  }
  function fmtDur(min) {
    if (min < 60) return min + "m";
    if (min < 1440) return Math.round(min/60) + "h";
    return Math.round(min/1440) + "d";
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  for (const id of ["market", "brand", "size", "sort"]) document.getElementById(id).addEventListener("change", refresh);
  let debounceTimer;
  document.getElementById("q").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  });
  refresh();
  setInterval(refresh, 20000);
</script>
</body>
</html>
`;

export interface DashboardServer {
  /** Binds the server; resolves with the actual port (useful when port is 0). */
  start(): Promise<number>;
  stop(): Promise<void>;
}

export function startDashboard(
  store: Store,
  port: number,
  getStats: () => string,
): DashboardServer {
  const app = Fastify({ logger: false });

  app.get("/", async (_req, reply) => {
    // Fastify serializes plain string returns as JSON — must set HTML type
    return reply.type("text/html; charset=utf-8").send(PAGE);
  });

  interface DealsQuery {
    market?: string;
    brand?: string;
    size?: string;
    sort?: string;
    q?: string;
  }

  /** Shared deal → wire-item mapper for /api/deals and /api/finds. */
  function dealItem(d: Deal) {
    return {
      title: d.listing.title,
      url: safeUrl(d.listing.url),
      imageUrl:
        d.listing.imageUrl && isAllowedImageUrl(d.listing.imageUrl)
          ? `/api/thumb?u=${encodeURIComponent(d.listing.imageUrl)}`
          : null,
      size: d.listing.size ?? null,
      condition:
        d.listing.condition ??
        (d.listing.title ? extractCondition(d.listing.title) : undefined) ??
        null,
      marketLabel: MARKET_LABEL[d.listing.market],
      priceLabel:
        d.listing.currency === "JPY"
          ? `¥${d.listing.price.toLocaleString("en-US")} ≈ $${d.listing.priceUsd.toFixed(0)}`
          : `$${d.listing.priceUsd.toFixed(2)}`,
      score: d.score,
      reasons: d.reasons,
      proxy: d.proxy,
      endsInMin: d.listing.endsAt
        ? Math.round((Date.parse(d.listing.endsAt) - Date.now()) / 60_000)
        : null,
    };
  }

  app.get<{ Querystring: DealsQuery }>("/api/deals", async (req) => {
    const { market, brand, size, sort, q } = req.query;
    // NB: "all" is a wildcard inside recentDeals — adding it alongside a
    // brand key would make the brand filter a no-op. The third arg scopes
    // the SQL to the brand so niche brands aren't starved by newer deals.
    let deals: Deal[] = store.recentDeals(brand ? [brand] : ["all"], 200, brand);

    // Bot-matching semantics: exact, case-insensitive; listings without a
    // size never match a size-filtered view (see notify/matching.ts).
    if (size) {
      const want = size.toLowerCase();
      deals = deals.filter((d) => (d.listing.size ?? "").toLowerCase() === want);
    }
    if (market) deals = deals.filter((d) => d.listing.market === market);
    if (q) deals = deals.filter((d) => d.listing.title.toLowerCase().includes(q.toLowerCase()));
    if (sort === "score") deals = [...deals].sort((a, b) => b.score - a.score);
    if (sort === "price") deals = [...deals].sort((a, b) => a.listing.priceUsd - b.listing.priceUsd);

    return {
      deals: deals.slice(0, 80).map(dealItem),
      stats: getStats(),
    };
  });

  /** Top finds of the day — same rankFinds ranking the /finds command uses. */
  app.get("/api/finds", async () => {
    const pool = store.recentDeals(["all"], 500);
    return {
      finds: rankFinds(pool, 24).map((f) => ({
        ...dealItem(f.deal),
        rank: f.rank,
        tier: f.rarity,
        findLabel: `#${f.rank} ${f.rarity}-tier · ${f.findsScore} pts`,
      })),
    };
  });

  app.get("/api/sizes", async () => {
    const rows = store.recentListings(24 * 14) as Array<{ size: string | null }>;
    const sizes = [...new Set(rows.map((r) => r.size).filter((s): s is string => !!s))].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
    );
    return sizes;
  });

  app.get("/api/health", async () => {
    return {
      ok: true,
      markets: ALL_MARKETS,
      rules: THRESHOLD_RULES.length,
      brands: BRANDS.length,
    };
  });

  // Local thumbnail proxy: the browser never talks to market CDNs directly;
  // this endpoint fetches whitelisted https image URLs server-side.
  app.get<{ Querystring: { u?: string } }>("/api/thumb", async (req, reply) => {
    const { u } = req.query;
    if (!u || !isAllowedImageUrl(u)) {
      return reply.code(400).send({ error: "bad image url" });
    }
    try {
      const thumb = await fetchThumb(u);
      return reply
        .header("content-type", thumb.contentType)
        .header("cache-control", "public, max-age=86400")
        .send(thumb.body);
    } catch {
      return reply.code(502).send({ error: "thumb fetch failed" });
    }
  });

  return {
    async start() {
      await app.listen({ port, host: "0.0.0.0" });
      const addr = app.server.address();
      return typeof addr === "object" && addr ? addr.port : port;
    },
    async stop() {
      await app.close();
    },
  };
}
