# SwagScout Roadmap

Status at this revision: `main` at `226d7de`, released as v0.6.0. Suite 365/365 across 40 files, required checks `ci` + `docker` + `flake-smoke` (suite ×3) on every PR, nightly image smoke on `main`, release automation attaches the image to every `v*` tag. Everything below is scoped against the code and the live store as they exist today.

**v0.4.0 — delivered.** All three units shipped and released with the image attached: live FX with cached fallback (#50–#52), dashboard accessibility (#49, #54), sold-velocity signals (#48) — plus the read-time money/reasons rendering and FX-invariant references they rest on (#53) and the install guide for non-technical users (#56).

---

## v0.5.0

**Delivered as v0.5.0 (tag + image asset).** Sell-through-weighted finds (#62), the price-event ledger (#63), `/velocity` (#64), condition-aware threshold rules (#65, `PIPELINE_VERSION` 7 recompute) — plus the condition thread unit 5 opened: condition-aware finds (#66) and the dashboard condition filter (#67). Unit 1's block-detection half (#58) shipped before the beta; its proxy half (unit 1B) remains operational — awaiting a residential `BROWSER_PROXY`. Unit 6 (subscription onboarding) was **not built**; the alert loop still has no production subscriptions.

Ranked by value-for-cost, each with an honest exit gate. Unit bodies keep their original gap/design/exit-gate text as the record of intent — shipped units are marked in their headings. Evidence numbers are from the live store (12,618 listings, 8,624 deals) the day the units were drafted.

### 1. Wake the West — M, shipped as two units

**The gap.** The README's headline pitch is JP↔West arbitrage ("a Yahoo JP piece 60% under its Grailed comps"). The store says it has never happened: **Grailed 0 rows, eBay 0 rows**, and of **317 comp-backed deals, 0 cite a West-side listing**. Every comp set is JPY-only, so the cross-market engine — the product's actual edge — has never had two sides. Market health (#55) makes the absence visible (`grailed✓ 0/24h`), but visibility isn't rows.

**Unit A — make Grailed able to answer (S).** Two parts: (a) the adapter currently resolves empty on a Cloudflare block page, so a blocked Grailed reads ✓ 0/24h — teach it to distinguish a block page from a genuinely empty result so market health shows `!` *(shipped as #58)*; (b) enable ingest through `BROWSER_PROXY` (already plumbed) with a residential proxy *(the remaining operational step)*.

**Unit B — eBay keys onboarding (S).** The adapter is code-ready against the official Browse API; it needs `EBAY_APP_ID`/`EBAY_CERT_ID` and a first-run smoke check. Document the exact free-tier registration steps in `.env.example` comments.

**Exit gate.** `npm run smoke` yields Grailed rows through the proxy; a simulated block page flips market health to `!`; comp deals citing ≥1 West-side listing goes from **0 to > 0** — the metric the whole unit exists for.

### 2. Sell-through-weighted finds — M — **delivered as #62**

**Shipped.** Finds ranking consumes the sell-through aggregation; the ⚡ fast-mover label appears at gone-now share ≥ 0.5 with the honest framing (absence is never called a sale); surfaces on the dashboard finds section and `/finds`.

**The gap.** 4,769 listings carry `missingSince` — real sell-through observations per brand and price band — and finds ranking ignores all of them. A 40%-below-median piece in a brand whose stock vanishes within 48h is a better buy than the same discount in a brand that never moves; the data to know that already exists.

**Design.** Aggregate gone-now observations per brand (and coarse price band) into a sell-through factor; feed it into `rankFinds` alongside comp discount, sample confidence, and price significance. Honest-label discipline carries over from #48: the factor says "pieces like this stop being listed soon", never "this sold". Surfaces: finds score breakdown, a digest line for velocity-backed finds, and the dashboard finds section.

**Exit gate.** Tests: `/finds` reorders under simulated velocity with unchanged comp data; the factor is stable across an FX refresh. Live: a find whose rank moves on velocity shows the factor in its label.

### 3. Price-event ledger — M — **delivered as #63**

**Shipped.** Append-only `price_events` written on every real move (pure FX writes nothing), deal reasons quote the price on the card at read time, and the ledger is pruned with its listing by retention.

**The gap.** Deals are one row per listing (right for dedupe, wrong for history): a price drop overwrites the row, so drop history is unqueryable. "Dropped 3× this week" is the strongest urgency signal a reseller gets, and we can't see it.

**Design.** Append-only `price_events(listingKey, at, price, priceUsd, currency)` written by the poller whenever an upsert moves a price. Consumers in order: re-alert policy (Nth drop), a per-listing drop sparkline on the dashboard, time-aware comp medians. Pruned with the listing by the existing retention pass. No `PIPELINE_VERSION` bump — the ledger is additive and nothing existing reads it yet.

**Exit gate.** Tests: two drops → three events, no duplicates on unchanged price; retention removes a listing's events. Live: a real drop produces a queryable event within one poll interval.

### 4. Brand velocity command — S — **delivered as #64**

**Shipped.** `/velocity` in Discord and a dashboard Brand velocity row over the last 20 sightings per brand, with the honest gone≤48h labels; the aggregation is exactly the prep layer unit 2 consumed.

**The gap.** "12 of the last 20 Y's pieces gone within 48h" is a one-SQL aggregation of columns that already exist, and it's the cheapest genuine new capability on this list.

**Design.** `/velocity brand:<key>` in Discord and a small dashboard section: gone-within-48h rate over the last 20 observations per brand, reusing #48's transition data with its honest labels. This is also the prep layer for unit 2 — the aggregation it needs is the same one the finds factor will consume.

**Exit gate.** Command output matches a direct SQL read of the live store for three brands; dashboard section renders the same numbers.

### 5. Condition-aware thresholds — S–M — **delivered as #65 (+ #66, #67)**

**Shipped.** Junk/damaged grades must clear half the cap (`junkFactor`, `conditionCaps` overrides), junk-grade pieces are capped out of A-tier finds, and the dashboard grew a "Junk/damaged only" filter; `PIPELINE_VERSION` bumped to 7 with boot-time recompute.

**The gap.** Condition is extracted and badged but ignored by scoring: a JP "junk" grade at 70% off isn't a deal, and today it scores like a mint one.

**Design.** Extend the threshold-rule shape with optional condition caps (e.g. exclude `junk`/`damaged` unless the price also clears a deeper discount), parsed from the same field the dashboard badges use. Rules stay config-only; the note discipline from the v0.3.0 de-duplication applies (notes never restate parameters).

**Exit gate.** Test matrix: junk-condition listing above the cap doesn't fire; below a deeper adjusted cap it does; rules without condition caps behave exactly as today.

### 6. Subscription onboarding — S *(not built; carried forward)*

**The gap.** Zero Discord subscriptions exist: the alert loop — the product's delivery mechanism — has never fired in production. The digest, matching, and routing are all tested and unexercised.

**Design.** A dashboard "watch this brand" affordance that deep-links the bot invite with the brand prefilled; `/status` gains alert health (subscriptions per channel, last alert sent). Honest triage first: if the Discord side simply isn't being used, that's a scope decision to make consciously, not a bug to fix.

**Exit gate.** A subscription created through the new affordance receives a real alert; `/status` shows it.

---

## v0.6.0

**Delivered as v0.6.0 (tag + image asset), `main` at `ae787c5`.** The theme that emerged: the dashboard became the product's front door, and the delivery bar rose to match.

- **Docs freshness audit (#68)** — README, INSTALL, ROADMAP and `.env.example` verified against shipped behavior.
- **Dashboard polish + results count (#69)** — the live dot visible again (breathing, reduced-motion aware), styled placeholder thumbs, inline favicon; `/api/deals` reports `matched`/`shown` so the feed says what filters matched. Fixed there: the condition select had been silently inert in the browser since #67 — the change-event loop never wired it.
- **URL filter sync (#70)** — the querystring is the source of truth on load (sizes included, via the async option rebuild) and a mirror on every refresh; filtered views survive reload and share as links, defaults keep URLs clean.
- **CONTRIBUTING.md (#71)** — public gates, PR flow, and the conventions tests enforce; its first CI run flushed out and fixed a clock-boundary flake in the `sellThroughByBrand` test.
- **Time-boundary convention (#72)** — suite-wide audit found that flake unique; the rule (pin `now` away from writes when probing zero-width windows) is written down.
- **Active-filter chips (#73, #74)** — one chip per non-default control (sort included) with one-click removal and Clear all, DOM-APIs-only, always in sync with control state; also fixed the finds/velocity/results sections sitting flush against the viewport edge (28px gutter now).
- **Flake-smoke CI (#75)** — third required check: the suite three times back-to-back in fresh processes, fail-fast, no retries.
- **README quality bar (#76)** — the three-check gate and release/nightly-image story documented for visitors.

**Still open (carried forward, unchanged from v0.5.0's assessment):** unit 1B's operational half — Grailed ingest needs a residential `BROWSER_PROXY` — and unit B, eBay keys onboarding; plus unit 6, subscription onboarding, still not built.

---

## Sequencing and scope boundary

**1 → 4 → 2.** Wake the West first (it feeds every comp number after it), velocity command second (cheap, and its aggregation is unit 2's input), sell-through-weighted finds third (the payoff). Units 3, 5, 6 are independent and can interleave anywhere. Each goes through the standard pipeline: branch → tests where possible → PR → `ci` + `docker` + `flake-smoke` → merge on green. Units 2–5 shipped in roughly the planned order; what remains of unit 1, plus unit 6, are the open items carried forward above.

**Deliberately parked (not v0.5.0; still parked):** multi-user auth and non-Discord notification surfaces (different product), scheduled deal re-alerts (needs the price-event ledger first), selling anything or multi-tenancy. None has an owner or a PR.

**Definition of done for v0.5.0 — met**, and the same bar held for v0.6.0: units merged through the pipeline, suite + drift smoke green, nightly image smoke passing on `main`, release notes drafted from the changelog, tag pushed with the image auto-attached and verified.
