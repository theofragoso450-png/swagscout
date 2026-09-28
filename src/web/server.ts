import Fastify from "fastify";
import type { Store } from "../core/store.js";
import { ALL_MARKETS, MARKET_LABEL } from "../types.js";
import { BRANDS, getBrand } from "../config/brands.js";
import { THRESHOLD_RULES } from "../config/rules.js";
import type { Deal } from "../types.js";
import { fetchThumb, isAllowedImageUrl } from "./thumbs.js";
import { extractCondition } from "../core/normalize.js";
import { formatReason } from "../core/reasons.js";
import { formatUsd } from "../core/money.js";
import { rankFinds, findsPool, FAST_MOVER_SHARE } from "../notify/finds.js";

const CONDITION_LABEL: Record<string, string> = {
  new: "New",
  "like-new": "Like new",
  used: "Used",
  junk: "Junk/damaged",
};

/**
 * Marketplace-controlled URLs must never reach the page with an executable
 * scheme; non-http(s) or unparseable values are nulled and render inert ("#").
 */
/** Shared human duration label (e.g. "3d 4h", "52m") for wire fields. */
function fmtDuration(mins: number): string {
  if (!Number.isFinite(mins) || mins < 0) return "";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Marketplace titles are frequently Japanese; a ja hint lets screen readers
 *  switch voice instead of reading kana/kanji with an English one. */
function detectTitleLang(title: string): string | null {
  return /[\u3040-\u30ff\u4e00-\u9fff]/.test(title) ? "ja" : null;
}

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
<html lang="en">
<head>
<meta charset="utf-8">
<title>SwagScout — archive fashion deals</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2016%2016'%3E%3Crect%20width='16'%20height='16'%20rx='3'%20fill='%230d1117'/%3E%3Ccircle%20cx='8'%20cy='8'%20r='4'%20fill='%233fb950'/%3E%3C/svg%3E">
<style>
  :root { color-scheme: dark; --gutter: 28px; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, sans-serif; background:#0d1117; color:#e6edf3; -webkit-font-smoothing:antialiased; }
  header { padding:22px var(--gutter); border-bottom:1px solid #21262d; display:flex; gap:16px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; letter-spacing:.5px; }
  h1 span { color:#3fb950; }
  .sub { color:#8b949e; font-size:13px; }
  .tagline { color:#8b949e; font-size:12.5px; margin-top:2px; }
  .bar { padding:14px var(--gutter); display:flex; gap:8px; flex-wrap:wrap; border-bottom:1px solid #21262d; }
  select, input { background:#161b22; color:#e6edf3; border:1px solid #30363d; border-radius:8px; padding:7px 10px; font-size:13px; transition:border-color .15s, background .15s; }
  select:hover, input:hover { border-color:#3d444d; }
  select:focus-visible, input:focus-visible { outline:none; border-color:#3fb950; box-shadow:0 0 0 3px rgba(63,185,80,.13); }
  .title a:focus-visible, .proxies a:focus-visible, .link:focus-visible { outline:2px solid #3fb950; outline-offset:2px; border-radius:4px; }
  select { cursor:pointer; }
  main { padding: 18px var(--gutter) 28px; }
  /* Skip link: first tab stop on the page; hidden until focused */
  .skip { position:absolute; left:-9999px; top:0; background:#161b22; color:#e6edf3; padding:8px 12px; border-radius:8px; z-index:10; }
  .skip:focus, .skip:focus-visible { left:8px; top:8px; }
  .deal { border:1px solid #21262d; border-radius:12px; padding:14px 16px; margin-bottom:12px; display:flex; gap:14px; background:#161b22; transition:border-color .15s, transform .15s; }
  .deal:hover { border-color:#3d444d; transform:translateY(-1px); }
  .deal img { width:76px; height:76px; object-fit:cover; border-radius:10px; background:#21262d; flex:none; }
  .deal img.imgph { background:linear-gradient(135deg,#1c2129,#262c36); }
  .imgph { display:inline-block; width:76px; height:76px; border-radius:10px; flex:none; background:linear-gradient(135deg,#1c2129,#262c36); border:1px dashed #30363d; }
  .meta { flex:1; min-width:0; }
  .title { font-weight:600; font-size:15px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .title a { color:#e6edf3; text-decoration:none; }
  .title a:hover { color:#58a6ff; }
  .row { font-size:12px; color:#8b949e; margin-top:6px; display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
  .price { color:#e6edf3; font-weight:600; font-size:13px; }
  .badge { background:#21262d; border-radius:999px; padding:1px 8px; font-size:11px; }
  .score { color:#3fb950; font-weight:700; background:rgba(63,185,80,.08); border:1px solid rgba(63,185,80,.25); border-radius:999px; padding:0 8px; font-size:11px; }
  .badge.size { color:#79c0ff; }
  .badge.cond-new { color:#3fb950; }
  .badge.cond-like-new { color:#d29922; }
  .badge.cond-used { color:#8b949e; }
  .badge.miss { color:#8b949e; font-style:italic; }
  .reasons { font-size:12px; color:#d29922; margin-top:4px; }
  .proxies a { color:#58a6ff; font-size:12px; margin-right:8px; text-decoration:none; }
  #finds, #velocity { padding: 0 var(--gutter); }
  .results { font-size:12px; color:#8b949e; padding:12px var(--gutter) 10px; min-height:16px; }
  .results:focus { outline:2px solid #3fb950; outline-offset:2px; border-radius:4px; }
  .chips-row { padding:12px var(--gutter) 0; }
  /* the row hosts focus after a chip removal (the clicked button unmounts);
     contents carry their own focus treatments */
  #chipsRow:focus { outline:none; }
  #chipsRow:focus-visible { outline:2px solid #3fb950; outline-offset:2px; }
  /* small screens: tighter shared gutter + real touch targets on chip removes */
  @media (max-width: 500px) {
    :root { --gutter: 16px; }
    .fchip { padding:3px 6px 3px 12px; }
    .fchip button { padding:4px 8px; font-size:15px; }
    .deal img, .imgph { width:60px; height:60px; }
  }
  .chips-row:empty { padding:0; }
  .fchip { border:1px solid #30363d; background:#161b22; border-radius:999px; padding:1px 4px 1px 10px; font-size:11px; color:#e6edf3; margin-right:8px; margin-bottom:4px; display:inline-flex; align-items:center; gap:6px; }
  .fchip button { background:none; border:none; color:#8b949e; cursor:pointer; font-size:13px; line-height:1; padding:0 4px; border-radius:999px; }
  .fchip button:hover { color:#f0883e; }
  .fchip button:focus-visible, .fclear:focus-visible { outline:2px solid #3fb950; outline-offset:1px; }
  .fclear { background:none; border:none; color:#58a6ff; cursor:pointer; font-size:11px; padding:2px 4px; }
  .fclear:hover { text-decoration:underline; }
  .empty { color:#8b949e; padding:40px 0; text-align:center; font-size:14px; position:relative; }
  .empty .imgph { width:44px; height:44px; margin:0 auto 10px; display:block; opacity:.5; }
  .link { background:none; border:none; color:#58a6ff; cursor:pointer; font-size:13px; padding:2px 4px; }
  .link:hover { text-decoration:underline; }
  .finds-head { font-size:16px; font-weight:700; margin:22px 0 10px; letter-spacing:.2px; display:flex; align-items:center; gap:10px; }
  .finds-head::before { content:""; width:8px; height:8px; border-radius:999px; background:#3fb950; box-shadow:0 0 8px rgba(63,185,80,.4); }
  .tier { border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; margin-right:8px; }
  .fast { border-radius:999px; padding:1px 8px; font-size:11px; font-weight:600; margin-right:8px; background:rgba(46,204,113,.12); color:#2ecc71; }
  .vchip { border-radius:999px; padding:2px 10px; font-size:11px; margin-right:8px; display:inline-block; margin-bottom:4px; color:#8b949e; background:rgba(139,148,158,.1); }
  .vchip.hot { color:#e67e22; background:rgba(230,126,34,.12); }
  .tier-S { background:#1f6feb; color:#ffffff; }
  .tier-A { background:#238636; color:#ffffff; }
  .tier-B { background:#9e6a03; color:#ffffff; }
  .tier-C { background:#30363d; color:#c9d1d9; }
  .finds-empty { color:#8b949e; font-size:13px; margin:10px 0 4px; }
  .dot { width:8px; height:8px; border-radius:999px; background:#30363d; display:inline-block; margin-right:6px; }
  .dot.on { background:#3fb950; box-shadow:0 0 6px rgba(63,185,80,.5); }
  .dot.err { background:#d29922; box-shadow:0 0 6px rgba(210,153,34,.5); }
  /* the live dot breathes while connected — the page's one ambient cue
     that data is still flowing; still under reduced-motion preferences */
  @keyframes breathe { 0%,100% { opacity:1; } 50% { opacity:.55; } }
  .dot.on { animation:breathe 2.4s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .dot.on { animation:none; } }
  .mchip.m-bad { color:#f0883e; font-weight:600; cursor:help; }
  .mchip.m-unk { color:#8b949e; border-bottom:1px dashed #3d444d; cursor:help; }
  .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }
</style>
</head>
<body>
<a class="skip" href="#feed">Skip to deals</a>
<header>
  <div>
    <h1>Swag<span>Scout</span></h1>
    <div class="tagline">Live cross-market scout for archive fashion deals</div>
  </div>
  <div class="sub"><span id="dot" class="dot" aria-hidden="true"></span><span id="live" class="sr-only" role="status" aria-live="polite"></span><span id="stats">loading…</span></div>
</header>
<div class="bar">
  <select id="market" aria-label="Market"><option value="">All markets</option></select>
  <select id="brand" aria-label="Brand"><option value="">All brands</option></select>
  <select id="size" aria-label="Size"><option value="">All sizes</option></select>
  <select id="condition" aria-label="Condition"><option value="">All conditions</option><option value="junk">Junk/damaged only</option></select>
  <select id="sort" aria-label="Sort by">
    <option value="found">Newest</option>
    <option value="score">Best score</option>
    <option value="price">Lowest price</option>
  </select>
  <input id="q" type="search" aria-label="Filter titles" placeholder="Filter titles…">
</div>
<section id="finds">
  <h2 class="finds-head">Finds of the day</h2>
  <div id="findsPulse"></div>
</section>
<section id="velocity">
  <h2 class="finds-head">Brand velocity</h2>
  <div id="velocityRow" aria-label="How fast each brand's listings vanish, over its last 20 sightings"></div>
</section>
<div id="chipsRow" class="chips-row"></div>
<div id="results" class="results" role="status" aria-live="polite" tabindex="-1"></div>
<main id="feed" tabindex="-1"><div class="empty"><div class="imgph" aria-hidden="true"></div><div>Scouting markets — first deals land within minutes.</div></div></main>
<script>
  const markets = ${JSON.stringify(ALL_MARKETS.map((m) => ({ id: m, label: MARKET_LABEL[m] })))};
  const brands = ${JSON.stringify(BRANDS.map((b) => ({ key: b.key, name: b.name })))};
  const conditionLabels = ${JSON.stringify(CONDITION_LABEL)};
  const PLACEHOLDER = '<div class="imgph" aria-hidden="true"></div>';
  for (const m of markets) {
    document.getElementById("market").insertAdjacentHTML("beforeend", \`<option value="\${m.id}">\${m.label}</option>\`);
  }
  for (const b of brands) {
    document.getElementById("brand").insertAdjacentHTML("beforeend", \`<option value="\${b.key}">\${b.name}</option>\`);
  }
  const sizeSel = document.getElementById("size");
  // Shared/filtered views: the querystring is the source of truth on load —
  // filters preselect from it (unknown values fall back to "All …") so a
  // reloaded or shared URL restores the exact view. Size options load
  // async, so ?size= preselects right after the first option rebuild —
  // the first feed fetch waits for that (boot chain at the bottom).
  const params = new URLSearchParams(location.search);
  const paramVal = (k) => params.get(k) || "";
  for (const id of ["market", "brand", "condition", "sort"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    const v = paramVal(id);
    if ([...el.options].some((o) => o.value === v)) el.value = v;
  }
  document.getElementById("q").value = paramVal("q");
  async function rebuildSizeOptions() {
    const keep = sizeSel.value;
    const res = await fetch("/api/sizes");
    const sizes = await res.json();
    sizeSel.innerHTML = '<option value="">All sizes</option>' +
      sizes.map((s) => \`<option value="\${escapeHtml(s)}">\${escapeHtml(s)}</option>\`).join("");
    if ([...sizeSel.options].some((o) => o.value === keep)) sizeSel.value = keep;
    else sizeSel.value = "";
  }
  setInterval(rebuildSizeOptions, 60000);
  async function loadFinds() {
    const pulse = document.getElementById("findsPulse");
    let data;
    try {
      const res = await fetch("/api/finds");
      data = await res.json();
    } catch { return; }
    if (!data.finds.length) {
      pulse.innerHTML = PLACEHOLDER +
        '<div class="finds-empty">No comp-backed finds yet — deals sitting far below a cross-market median rank here once the comp engine warms up.</div>';
      return;
    }
    pulse.innerHTML = data.finds.map(render).join("");
  }
  loadFinds();
  setInterval(loadFinds, 60000);
  // Brand velocity: gone-within-48h churn per brand, over its last 20
  // sightings. DOM APIs only — marketplace-adjacent data never touches markup.
  async function loadVelocity() {
    const row = document.getElementById("velocityRow");
    if (!row) return;
    let data;
    try {
      const res = await fetch("/api/velocity");
      data = await res.json();
    } catch { return; }
    if (!data.brands || !data.brands.length) {
      // same empty treatment as the finds section, not blank space
      row.textContent = "";
      const note = document.createElement("div");
      note.className = "finds-empty";
      note.textContent = "No brand sightings yet — velocity appears after the first poll rounds.";
      row.appendChild(note);
      return;
    }
    row.textContent = "";
    for (const v of data.brands || []) {
      const chip = document.createElement("span");
      chip.className = "vchip" + (v.rate >= 0.5 ? " hot" : "");
      chip.textContent = v.name + " " + v.goneWithin48h + "/" + v.observed + " gone≤48h";
      chip.title = v.observed + " sightings considered; " + v.goneWithin48h +
        " vanished within 48h of being found. Gone = absent from recent poll rounds — absence is not proof of sale.";
      row.appendChild(chip);
    }
  }
  loadVelocity();
  setInterval(loadVelocity, 60000);
  // Active-filter chips: one per non-default control, each with a one-click
  // remove button, plus Clear all. Built with DOM APIs only — filter values
  // are user input and must never touch markup. Labels resolve ids to the
  // human names the selects display; long free-text queries truncate.
  // Sort is chipped too (every non-default control mirrors here); its
  // removal resets to "Newest" ("found"), the only control without an
  // empty option.
  const SORT_DEFAULT = "found";
  const optionText = (sel, v) => {
    const o = [...sel.options].find((o) => o.value === v);
    return o ? o.textContent : v;
  };
  const marketLabel = (id) => (markets.find((x) => x.id === id) || {}).label || id;
  const brandLabel = (k) => (brands.find((x) => x.key === k) || {}).name || k;
  function renderChips() {
    const row = document.getElementById("chipsRow");
    if (!row) return;
    row.textContent = "";
    const chips = [];
    const m = document.getElementById("market").value;
    const b = document.getElementById("brand").value;
    const z = sizeSel.value;
    const c = document.getElementById("condition").value;
    const s = document.getElementById("sort").value;
    const q = document.getElementById("q").value;
    if (m) chips.push(["market", "Market: " + marketLabel(m)]);
    if (b) chips.push(["brand", "Brand: " + brandLabel(b)]);
    if (z) chips.push(["size", "Size: " + z]);
    if (c) chips.push(["condition", "Condition: " + (conditionLabels[c] || c)]);
    if (s && s !== SORT_DEFAULT) chips.push(["sort", "Sort: " + optionText(document.getElementById("sort"), s)]);
    if (q) chips.push(["q", "Title: " + (q.length > 24 ? q.slice(0, 24) + "…" : q)]);
    if (!chips.length) return;
    row.tabIndex = -1;
    for (const [id, label] of chips) {
      const chip = document.createElement("span");
      chip.className = "fchip";
      chip.appendChild(document.createTextNode(label + " "));
      const x = document.createElement("button");
      x.setAttribute("aria-label", "Remove filter " + label);
      x.textContent = "×";
      x.addEventListener("click", () => removeFilter(id));
      chip.appendChild(x);
      row.appendChild(chip);
    }
    const all = document.createElement("button");
    all.className = "fclear";
    all.textContent = "Clear all";
    all.addEventListener("click", () => {
      const row = document.getElementById("chipsRow");
      if (row) row.focus();
      clearFilters();
    });
    row.appendChild(all);
  }
  function removeFilter(id) {
    document.getElementById(id).value = id === "sort" ? SORT_DEFAULT : "";
    // the clicked button is about to be unmounted by the re-render: move
    // focus back to the chips row so keyboard users are not dumped to body
    const row = document.getElementById("chipsRow");
    if (row) row.focus();
    refresh();
  }
  // Mirror active filters into the address bar via replaceState: shareable,
  // reload-stable, and no history entry per 20-second poll. Defaults are
  // omitted so an all-defaults view carries a clean URL.
  function syncUrl() {
    const sp = new URLSearchParams();
    for (const id of ["market", "brand", "size", "condition", "sort"]) {
      const v = document.getElementById(id).value;
      if (v && !(id === "sort" && v === "found")) sp.set(id, v);
    }
    const q = document.getElementById("q").value;
    if (q) sp.set("q", q);
    const qs = sp.toString();
    history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
  }
  let timer;
  async function refresh() {
    const p = new URLSearchParams();
    const m = document.getElementById("market").value;
    const b = document.getElementById("brand").value;
    const z = sizeSel.value;
    const c = document.getElementById("condition").value;
    const s = document.getElementById("sort").value;
    const q = document.getElementById("q").value;
    if (m) p.set("market", m);
    if (b) p.set("brand", b);
    if (z) p.set("size", z);
    if (c) p.set("condition", c);
    if (s) p.set("sort", s);
    if (q) p.set("q", q);
    let data;
    try {
      const res = await fetch("/api/deals?" + p.toString());
      // HTTP-level failures (500s etc.) must read as failure, not success —
      // a 500 with a parseable body would otherwise skip the catch below.
      if (!res.ok) { markLive(false); return; }
      data = await res.json();
    } catch { markLive(false); return; }
    markLive(true);
    syncUrl();
    renderChips();
    const feed = document.getElementById("feed");
    const results = document.getElementById("results");
    if (!data.deals.length) {
      // textContent only — marketplace-adjacent values never touch markup.
      if (results) results.textContent = "0 deals match the current filters.";
      feed.innerHTML = '<div class="empty">' + PLACEHOLDER + '<div>No deals match your filters.</div><button class="link" id="clearFilters">Clear filters</button></div>';
      const cf = document.getElementById("clearFilters");
      if (cf) cf.addEventListener("click", clearFilters);
    } else {
      if (results) results.textContent = data.shown + " of " + data.matched + " deals shown";
      feed.innerHTML = data.deals.map(render).join("");
    }
    renderStats(data);
  }
  // Status chips: per-market liveness with an explanation on hover. Built with
  // DOM APIs (no innerHTML) so marketplace-adjacent data never touches markup.
  function renderStats(data) {
    const el = document.getElementById("stats");
    if (!el) return;
    el.textContent = "";
    el.appendChild(document.createTextNode((data.stats || "") + "  ·  "));
    const mh = data.marketHealth || [];
    mh.forEach((m, i) => {
      if (i) el.appendChild(document.createTextNode(" · "));
      const state = m.lastRoundOk === true ? "ok" : m.lastRoundOk === false ? "bad" : "unk";
      const chip = document.createElement("span");
      chip.className = "mchip m-" + state;
      chip.textContent = m.market + (state === "ok" ? "✓" : state === "bad" ? "!" : "?") + " " + (m.rows24h || 0) + "/24h";
      chip.title = state === "ok"
        ? "Market healthy — last poll succeeded."
        : state === "bad"
          ? "Not answering — the last poll failed. Deal alerts for this market pause until it responds."
          : "Not polled yet — status appears after the first poll round (about a minute).";
      el.appendChild(chip);
    });
  }
  const dot = document.getElementById("dot");
  const live = document.getElementById("live");
  function markLive(ok) {
    if (!dot) return;
    // Full class string: the base class carries size/color hooks the state
    // classes stack onto — toggling alone once lost it and the dot vanished.
    // Only written on an actual state change: reassigning the same string
    // invalidates style and would restart the dot's breathe every refresh.
    const next = ok ? "dot on" : "dot err";
    if (dot.className !== next) dot.className = next;
    if (live) live.textContent = ok ? "Live — feed updated" : "Feed fetch failed — retrying";
  }
  function clearFilters() {
    for (const id of ["market", "brand", "size", "condition"]) document.getElementById(id).value = "";
    // sort has no empty option — resetting to "" would blank the dropdown.
    document.getElementById("sort").value = "found";
    document.getElementById("q").value = "";
    syncUrl();
    refresh();
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
      \${d.imageUrl ? \`<img src="\${escapeHtml(safeUrl(d.imageUrl))}" alt="" loading="lazy" onerror="this.classList.add('imgph');this.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'">\` : "<img class='img imgph' src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' alt=''>"}
      <div class="meta">
        <div class="title">\${d.rank != null ? \`<span class="tier tier-\${escapeHtml(d.tier)}">\${escapeHtml(d.findLabel)}</span>\${d.fast ? '<span class="fast" title="Pieces from this brand tend to stop being listed soon (gone-now share of its current stock). Absence is not proof of sale.">⚡ fast mover</span>' : ""}\` : ""}<a href="\${escapeHtml(safeUrl(d.url))}" target="_blank"\${d.titleLang ? \` lang="\${escapeHtml(d.titleLang)}"\` : ""}>\${escapeHtml(d.title)}</a></div>
        <div class="row">
          <span class="badge">\${escapeHtml(d.marketLabel)}</span>
          \${d.size ? \`<span class="badge size">\${escapeHtml(d.size)}</span>\` : ""}
          \${!isFind && d.condition ? \`<span class="badge cond cond-\${escapeHtml(d.condition)}">\${escapeHtml(conditionLabels[d.condition] || d.condition)}</span>\` : ""}
          <span class="price">\${d.priceLabel}</span>
          <span class="score">score \${d.score}</span>
          \${!isFind && d.endsInMin != null && d.endsInMin > 0 ? \`<span>ends in \${fmtDur(d.endsInMin)}</span>\` : ""}
          \${!isFind && d.missingForLabel ? \`<span class="badge miss">Sold or delisted \${escapeHtml(d.missingForLabel)}</span>\` : ""}
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
  for (const id of ["market", "brand", "size", "condition", "sort"]) document.getElementById(id).addEventListener("change", refresh);
  let debounceTimer;
  document.getElementById("q").addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 300);
  });
  // First feed load waits for the size options so a shared ?size= can
  // preselect before the initial fetch (otherwise the first syncUrl would
  // drop it); later rebuilds preserve the value via keep-current-value.
  rebuildSizeOptions()
    .catch(() => {})
    .then(() => {
      const v = paramVal("size");
      if (v && [...sizeSel.options].some((o) => o.value === v)) sizeSel.value = v;
      refresh();
      setInterval(refresh, 20000);
    });
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
    condition?: string;
    sort?: string;
    q?: string;
  }

  /** Shared deal → wire-item mapper for /api/deals and /api/finds. */
  function dealItem(d: Deal) {
    return {
      title: d.listing.title,
      titleLang: detectTitleLang(d.listing.title),
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
          ? `¥${d.listing.price.toLocaleString("en-US")} ≈ ${formatUsd(d.listing.priceUsd)}`
          : formatUsd(d.listing.priceUsd),
      score: d.score,
      // Rendered against the price this card prints — a stored line would name
      // whatever the rate was when the deal was recorded.
      reasons: d.reasons.map((r) => ({ kind: r.kind, detail: formatReason(r, d.listing.priceUsd) })),
      // Honest sold-velocity: absence ≠ sale, so the label says both.
      missingForLabel: d.listing.missingSince
        ? fmtDuration(Math.round((Date.now() - Date.parse(d.listing.missingSince)) / 60_000)) || null
        : null,
      proxy: d.proxy,
      endsInMin: d.listing.endsAt
        ? Math.round((Date.parse(d.listing.endsAt) - Date.now()) / 60_000)
        : null,
    };
  }

  app.get<{ Querystring: DealsQuery }>("/api/deals", async (req) => {
    const { market, brand, size, condition, sort, q } = req.query;
    // NB: "all" is a wildcard inside recentDeals — adding it alongside a
    // brand key would make the brand filter a no-op. The third arg scopes
    // the SQL to the brand so niche brands aren't starved by newer deals.
    let deals: Deal[] = store.recentDeals(brand ? [brand] : ["all"], 200, { brand });

    // Bot-matching semantics: exact, case-insensitive; listings without a
    // size never match a size-filtered view (see notify/matching.ts).
    if (size) {
      const want = size.toLowerCase();
      deals = deals.filter((d) => (d.listing.size ?? "").toLowerCase() === want);
    }
    if (market) deals = deals.filter((d) => d.listing.market === market);
    // Title-derived at read time (the stored column is only a display cache);
    // exact match like the size filter — a listing without the grade never
    // matches a condition-filtered view.
    if (condition) {
      deals = deals.filter((d) => (extractCondition(d.listing.title) ?? null) === condition);
    }
    if (q) deals = deals.filter((d) => d.listing.title.toLowerCase().includes(q.toLowerCase()));
    if (sort === "score") deals = [...deals].sort((a, b) => b.score - a.score);
    if (sort === "price") deals = [...deals].sort((a, b) => a.listing.priceUsd - b.listing.priceUsd);

    return {
      deals: deals.slice(0, 80).map(dealItem),
      /** Post-filter total: the header stats are global, so the count line
       *  above the feed needs this to say how many deals the filters matched
       *  (shown caps at 80; matched can exceed it). */
      matched: deals.length,
      shown: Math.min(deals.length, 80),
      stats: getStats(),
      /** Per-market liveness for the status chips (see renderStats client-side). */
      marketHealth: store.marketHealth(),
    };
  });

  /** Top finds of the day — same rankFinds ranking the /finds command uses. */
  app.get("/api/finds", async () => {
    const pool = findsPool(Date.now());
    const velocity = store.sellThroughByBrand(24);
    return {
      finds: rankFinds(store.recentDeals(["all"], pool.limit, { since: pool.since }), 24, Date.now(), 10, { velocity }).map((f) => ({
        ...dealItem(f.deal),
        rank: f.rank,
        tier: f.rarity,
        findLabel: `#${f.rank} ${f.rarity}-tier · ${f.findsScore} pts`,
        fast: f.deal.listing.brandKey ? (velocity.get(f.deal.listing.brandKey)?.share ?? 0) >= FAST_MOVER_SHARE : false,
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

  /** Brand velocity — the /velocity command's metric, for the dashboard. */
  app.get("/api/velocity", async () => {
    const all = store.brandVelocityAll(20);
    const brands = [...all.entries()]
      .filter(([, s]) => s.observed > 0)
      .map(([key, s]) => ({ key, name: getBrand(key)?.name ?? key, ...s }))
      .sort((a, b) => b.rate - a.rate || b.observed - a.observed);
    return { brands };
  });

  app.get("/api/health", async () => {
    return {
      ok: true,
      markets: ALL_MARKETS,
      rules: THRESHOLD_RULES.length,
      brands: BRANDS.length,
      /** Per-market liveness: last completed round, its outcome, 24h row counts. */
      marketHealth: store.marketHealth(),
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
