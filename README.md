# SwagScout 🧥📡

Self-hosted archive-fashion deal bot, inspired by [swagsearch.io](https://swagsearch.io/). It continuously polls **five resale markets**, detects **underpriced** archive pieces two different ways, and pushes rich **Discord alerts** with proxy-buying links — plus a live web dashboard.

## Markets

| Market | Method | Status & notes |
|---|---|---|
| Yahoo Auctions JP | HTML scraping | ✅ Working. Richest archive source; Buyee/ZenMarket/Sendico links on every alert |
| Mercari JP | Headless browser (SPA render), JSON API fallback | ✅ Working. The public JSON API version-drifts (currently `UnsupportedVersionException`), so the browser route runs first |
| Rakuma (fril.jp) | HTML scraping | ✅ Working. 2026 markup: `item.fril.jp/<hex>` URLs; numeric id pulled from the page's GA payload for proxy links |
| Grailed | Unofficial JSON endpoint via headless browser | ⚠️ Code-ready; Cloudflare **IP-blocks** many datacenter/VPS IPs (plain Chrome gets "Attention Required"). Set `BROWSER_PROXY` to a residential proxy to enable |
| eBay | Official **Browse API** (OAuth2) | 🔑 Needs free keys from [developer.ebay.com](https://developer.ebay.com); legacy Finding API was decommissioned Feb 2025 |

Verify any time with `npm run smoke` — it polls every enabled market once and prints per-market stats.

## Deal detection (both engines)

1. **Threshold rules** — per-brand USD caps with exclude terms (reps, wallets, fragrances…), e.g. *"CDG shirts ≤ $120"*, *"Yohji mainline ≤ $350"*. Predictable, instant. See `src/config/rules.ts`.
2. **Cross-market comps** — fuzzy-matches the same item across markets (token overlap + trigram similarity on titles, brand slug enforced, price-band prefilter) and alerts when a listing sits **≥35% below the median** of ≥3 comparable listings across the last 14 days. This works across the JP↔West divide — e.g. a Yahoo JP piece 60% under its Grailed comps.
3. **Score** — thresholds (40) + comp discount depth (≤50) + price-drop bonus (15) + auction-ending-soon urgency (10). Drives embed color and dashboard sort.

Price-drop detection: re-seen listings that drop ≥3% re-alert with the old→new price.

## Quick start

```bash
npm install
cp .env.example .env        # fill in DISCORD_TOKEN (+ eBay keys if you have them)
npm run smoke               # one live poll of every market — verify scrapers work
npm run smoke:drift         # live poll into a throwaway DB, then assert stored brand/size == what the current matchers compute (fails on drift)
npm start                   # poller + Discord + dashboard on :3080
```

Requirements: **Node 23+** (uses the built-in `node:sqlite` — no native compile step).

### Discord setup

1. Create an app at <https://discord.com/developers> → Bot → Reset Token → put it in `DISCORD_TOKEN`.
2. Invite the bot with the `bot` + `applications.commands` scopes (no special permissions needed beyond sending messages in the target channels).
3. In Discord: `/watch brand:raf` in the channel that should receive Raf Simons alerts, `/watch brand:all` for everything, optionally with `min_score` and `size`.
4. Commands: `/watch` `/unwatch` `/brands` `/status` `/deals` `/finds`.

**Filters:** a subscription can combine `brand`, `min_score`, and `size`. `size` is an exact, case-insensitive match against the size extracted at ingest (`M`, `28`, `W34`, …) — listings without a size never match a size-filtered channel. Re-running `/watch` for the same brand updates that subscription; omitting `size` clears the filter. Example: `/watch brand:yohji min_score:50 size:M` alerts only Yohji pieces in M scoring 50+.

**`/deals` previews your channel's alerts:** it applies the same matching logic as alert routing (brand + min_score + size) to recent deals, so what it shows is exactly what that channel would be alerted about. Without subscriptions it falls back to all recent deals.

**`/finds` ranks the day's top 10 finds:** only comp-backed deals (a cross-market median they sit below) can rank, scored on rarity — how far below the median and how many listings back it — plus price significance (a 50% cut on a $2,000 coat outranks one on a $60 shirt). Each result shows a finds score and rarity tier (S/A/B/C); `hours: <n>` widens the look-back window (1–168h, default 24).

Webhook-only mode also works: set `DISCORD_WEBHOOK_URL` instead of a token (alerts only, no commands).

### eBay keys

Register at <https://developer.ebay.com> (free "Individual" account is fine), create a key set, and put the **App ID (Client ID)** and **Cert ID (Client Secret)** into `EBAY_APP_ID` / `EBAY_CERT_ID`. Without them every other market still works and eBay is simply disabled.

## Configuration

All via environment variables — see `.env.example`. Highlights:

- `SWAGSCOUT_WATCH` — comma-separated brand keys to poll (default: curated 17-brand list, incl. Bape, Evisu, early-2000s Supreme)
- `POLL_<MARKET>` — base interval in seconds per market (jitter added on top)
- `COMP_ROUND_USD` — price-band rounding for comp grouping (default 50)
- `RATE_LIMIT_RPM` — per-host politeness cap (default 12)
- `DISCORD_ALLOWED_CHANNELS` — channel allow-list for the bot
- `BROWSER_PROXY` — optional proxy for browser-based markets (see Grailed note above)

Brand catalog (38 brands with English + Japanese aliases — CDG, Number (N)ine, Yohji, Issey, Raf, Undercover, Nigo-era BAPE, Evisu, early-2000s Supreme, and more) lives in `src/config/brands.ts`; default thresholds in `src/config/rules.ts`. Edit those files to tune the watchlist — the /brands command lists every key.

## Dashboard

`http://localhost:3080` — live deal feed with market/brand filters, text search, score/price sort, proxy links, and a `/api/health` JSON endpoint for uptime monitors.

## Deployment (24/7)

```bash
docker compose up -d --build
```

The compose file mounts `./data` for the SQLite database so state survives restarts. The container is health-checked via the dashboard's `/api/health`.

## Architecture

```
src/
├── index.ts              # boot: env → store → adapters → poller → discord → dashboard
├── smoke.ts              # one-shot live poll of every market (no Discord needed)
├── config/
│   ├── brands.ts         # 38-brand catalog, EN + JP aliases, search terms per market
│   ├── rules.ts          # default threshold rules
│   └── env.ts            # env parsing + defaults
├── markets/              # one adapter file per market (normalized Listing out)
├── core/
│   ├── poller.ts         # rotation, jitter, circuit breakers, dedupe, price drops
│   ├── store.ts          # node:sqlite persistence (listings, deals, subs)
│   ├── normalize.ts      # brand match, size extraction, FX, canonical keys
│   ├── comps.ts          # trigram/Jaccard fuzzy comp matching + median
│   ├── score.ts          # deal evaluation (thresholds + comps → score)
│   ├── fx.ts             # currency → USD
│   └── http.ts           # rate-limited fetch with retries/backoff
├── notify/               # discord bot + webhooks + embed builders
├── proxy/links.ts        # Buyee / ZenMarket / Sendico URL builders
└── web/server.ts         # Fastify dashboard
```

Adding a market = one new adapter file in `src/markets/` implementing `MarketAdapter` (`search(query) → Listing[]`) plus a row in `index.ts`.

## Tests

```bash
npm test
```

52 unit/integration tests: Yahoo + Mercari parsers against HTML fixtures, brand matching (EN + JP), normalization/FX, threshold rules, scoring, proxy links, comp matching, and the SQLite store. Scrapers are fixture-based so CI never hits live sites; use `npm run smoke` for the live check, or `npm run smoke:drift` to boot the full stack on a throwaway DB/port, run one live poll round, and assert zero drift between stored and computed brand/size values (Grailed is exempt from the size check — its adapter passes explicit sizes).

## Legal note

Scraping is for personal/research use with polite rate limits (12 req/min/host, retries with backoff, circuit breakers). Marketplace ToS vary — Mercari and Rakuma are the most restrictive; Yahoo/Grailed are broadly tolerated for personal tooling. You are responsible for how you use this.
