# SwagScout Roadmap

Status at drafting: `main` at `4628bd5`, released as v0.4.0. Suite 304/304 across 34 files, required checks `ci` + `docker` on every PR (enforced for admins), nightly image smoke on `main`, release automation attaches the image to every `v*` tag. Everything below is scoped against the code and the live store as they exist today.

**v0.4.0 — delivered.** All three units shipped and released with the image attached: live FX with cached fallback (#50–#52), dashboard accessibility (#49, #54), sold-velocity signals (#48) — plus the read-time money/reasons rendering and FX-invariant references they rest on (#53) and the install guide for non-technical users (#56).

---

## v0.5.0

Ranked by value-for-cost, each with an honest exit gate. Evidence numbers are from the live store (12,618 listings, 8,624 deals) the day this was drafted.

### 1. Wake the West — M, shipped as two units

**The gap.** The README's headline pitch is JP↔West arbitrage ("a Yahoo JP piece 60% under its Grailed comps"). The store says it has never happened: **Grailed 0 rows, eBay 0 rows**, and of **317 comp-backed deals, 0 cite a West-side listing**. Every comp set is JPY-only, so the cross-market engine — the product's actual edge — has never had two sides. Market health (#55) makes the absence visible (`grailed✓ 0/24h`), but visibility isn't rows.

**Unit A — make Grailed able to answer (S).** Two parts: (a) the adapter currently resolves empty on a Cloudflare block page, so a blocked Grailed reads ✓ 0/24h — teach it to distinguish a block page from a genuinely empty result so market health shows `!`; (b) enable ingest through `BROWSER_PROXY` (already plumbed) with a residential proxy.

**Unit B — eBay keys onboarding (S).** The adapter is code-ready against the official Browse API; it needs `EBAY_APP_ID`/`EBAY_CERT_ID` and a first-run smoke check. Document the exact free-tier registration steps in `.env.example` comments.

**Exit gate.** `npm run smoke` yields Grailed rows through the proxy; a simulated block page flips market health to `!`; comp deals citing ≥1 West-side listing goes from **0 to > 0** — the metric the whole unit exists for.

### 2. Sell-through-weighted finds — M

**The gap.** 4,769 listings carry `missingSince` — real sell-through observations per brand and price band — and finds ranking ignores all of them. A 40%-below-median piece in a brand whose stock vanishes within 48h is a better buy than the same discount in a brand that never moves; the data to know that already exists.

**Design.** Aggregate gone-now observations per brand (and coarse price band) into a sell-through factor; feed it into `rankFinds` alongside comp discount, sample confidence, and price significance. Honest-label discipline carries over from #48: the factor says "pieces like this stop being listed soon", never "this sold". Surfaces: finds score breakdown, a digest line for velocity-backed finds, and the dashboard finds section.

**Exit gate.** Tests: `/finds` reorders under simulated velocity with unchanged comp data; the factor is stable across an FX refresh. Live: a find whose rank moves on velocity shows the factor in its label.

### 3. Price-event ledger — M

**The gap.** Deals are one row per listing (right for dedupe, wrong for history): a price drop overwrites the row, so drop history is unqueryable. "Dropped 3× this week" is the strongest urgency signal a reseller gets, and we can't see it.

**Design.** Append-only `price_events(listingKey, at, price, priceUsd, currency)` written by the poller whenever an upsert moves a price. Consumers in order: re-alert policy (Nth drop), a per-listing drop sparkline on the dashboard, time-aware comp medians. Pruned with the listing by the existing retention pass. No `PIPELINE_VERSION` bump — the ledger is additive and nothing existing reads it yet.

**Exit gate.** Tests: two drops → three events, no duplicates on unchanged price; retention removes a listing's events. Live: a real drop produces a queryable event within one poll interval.

### 4. Brand velocity command — S

**The gap.** "12 of the last 20 Y's pieces gone within 48h" is a one-SQL aggregation of columns that already exist, and it's the cheapest genuine new capability on this list.

**Design.** `/velocity brand:<key>` in Discord and a small dashboard section: gone-within-48h rate over the last 20 observations per brand, reusing #48's transition data with its honest labels. This is also the prep layer for unit 2 — the aggregation it needs is the same one the finds factor will consume.

**Exit gate.** Command output matches a direct SQL read of the live store for three brands; dashboard section renders the same numbers.

### 5. Condition-aware thresholds — S–M

**The gap.** Condition is extracted and badged but ignored by scoring: a JP "junk" grade at 70% off isn't a deal, and today it scores like a mint one.

**Design.** Extend the threshold-rule shape with optional condition caps (e.g. exclude `junk`/`damaged` unless the price also clears a deeper discount), parsed from the same field the dashboard badges use. Rules stay config-only; the note discipline from the v0.3.0 de-duplication applies (notes never restate parameters).

**Exit gate.** Test matrix: junk-condition listing above the cap doesn't fire; below a deeper adjusted cap it does; rules without condition caps behave exactly as today.

### 6. Subscription onboarding — S

**The gap.** Zero Discord subscriptions exist: the alert loop — the product's delivery mechanism — has never fired in production. The digest, matching, and routing are all tested and unexercised.

**Design.** A dashboard "watch this brand" affordance that deep-links the bot invite with the brand prefilled; `/status` gains alert health (subscriptions per channel, last alert sent). Honest triage first: if the Discord side simply isn't being used, that's a scope decision to make consciously, not a bug to fix.

**Exit gate.** A subscription created through the new affordance receives a real alert; `/status` shows it.

---

## Sequencing and scope boundary

**1 → 4 → 2.** Wake the West first (it feeds every comp number after it), velocity command second (cheap, and its aggregation is unit 2's input), sell-through-weighted finds third (the payoff). Units 3, 5, 6 are independent and can interleave anywhere. Each goes through the standard pipeline: branch → tests where possible → PR → `ci` + `docker` → merge on green.

**Deliberately parked (not v0.5.0):** multi-user auth and non-Discord notification surfaces (different product), scheduled deal re-alerts (needs the price-event ledger first), selling anything or multi-tenancy. None has an owner or a PR.

**Definition of done for v0.5.0:** all units merged through the pipeline, suite + drift smoke green, nightly image smoke passing on `main`, release notes drafted from the changelog, tag pushed with the image auto-attached and verified.
