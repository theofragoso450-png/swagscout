# SwagScout Roadmap

Status at drafting: `main` at `752be62`, released as v0.3.0. Suite 189/189 across 23 files, required checks `ci` + `docker` on every PR, nightly image smoke on `main`. Everything below is scoped against the code as it exists today.

The three v0.4.0 units, ranked by value-for-cost, each with an honest exit gate. They are independent — ship in any order; the recommended sequence is FX → accessibility → velocity.

---

## v0.4.0

### 1. Live FX rates with cached fallback — S effort

**The gap.** `src/core/fx.ts` is a hardcoded table (`JPY: 1/155`, plus EUR/GBP) whose own header says "refresh quarterly or wire a free FX API." Every threshold comparison, comp median, price label, and finds score is denominated at a yen rate that drifts daily. Rankings stay self-consistent (both sides of a comparison share the rate), but dollar labels slowly stop meaning what they say.

**Design.**

- Extend `Env` with `FX_REFRESH_HOURS` (default 24; `0` = keep the static table — an escape hatch, mirroring `RETENTION_DAYS=0`).
- A small fetcher (reusing the shared undici agent and its `allowH2:false` discipline) pulls `USD`/`JPY`/`EUR`/`GBP` from a keyless API (e.g. open.er-api.com or frankfurter.app), validates each rate is a positive finite number, and stores the snapshot in the store's existing `meta` table with a fetch timestamp.
- `toUsd` reads an in-memory snapshot refreshed from meta at boot; a failed fetch keeps the last good rates and logs a warning. The static table remains the ultimate fallback (fresh DB, never-fetched case).
- **Deliberately not a `PIPELINE_VERSION` bump:** rates are read-time conversions for display; stored `priceUsd` values keep their ingest-time rate. Restating all historical prices on a rate wiggle would churn every row for no decision value. If historical restatement is ever wanted, it is one more version bump — the machinery from the pipeline-versioning unit already exists.

**Exit gate.** Tests: fetch/validate/fallback matrix (good payload, malformed field, unreachable API); boot with a dead network still serves on cached rates. Live: dashboard labels move with the real rate; a forced-fetch-failure boot logs the warning and keeps serving.

### 2. Dashboard accessibility pass — S effort

**The gap.** The dashboard was polished visually (#43) but never audited for a11y. Known concrete issues, all observed while working on it:

- **Filter controls are unlabeled** — five `<select>`/`<input>` elements with no `<label>` or `aria-label`; screen readers announce "combobox" with no name.
- **Status is purely visual** — the live dot's green↔amber transition is invisible to non-sighted users.
- **Japanese titles** — no `lang` attribute, so roughly half the titles may be mispronounced by screen readers.
- **Contrast: verified non-issue.** Every foreground/background pair in the page was computed (WCAG relative-luminance formula): muted body text 5.62–6.15:1, reasons line 6.85:1, size/condition badges 4.95–7.91:1, tier badges 4.63–7.91:1 — **all pass AA's 4.5:1**. An earlier draft of this roadmap claimed ≈4.0:1 from memory; measurement said otherwise. Recorded here so the unit doesn't churn CSS that is already compliant.

**Design.**

- `aria-label`s on all five controls; `role="status"` + `aria-live="polite"` on the dot with its label toggled alongside the class; a visible `:focus-visible` treatment on deal-card links; `lang="ja"` spans on Japanese title segments. No CSS changes — contrast already passes AA (measured, see above).
- The innerHTML guard scans `${}` tokens only, so attribute additions pass unchanged — but the suite re-runs after the markup changes regardless.

**Exit gate.** Asserted through the real surface: `preview_snapshot` exposes the accessibility tree — every control has an accessible name and the dot exposes its state; contrast re-computed ≥ 4.5:1 (already true today, re-asserted after changes). Suite + guard green.

### 3. Sold-velocity signals ("selling fast") — M effort

**The gap.** The bot knows what's cheap but not what's *moving*. For an archive flipper, disappearance across poll rounds is genuine market memory — the exact edge the tool is built around. Nothing records it today: the poller upserts and moves on.

**Design.**

- **Signal capture (poller):** when a listing seen last round is absent now, record the transition (`lastSeenAt`/`missingSince` columns on `listings`). Guard rails that matter:
  - A listing must be absent from a **complete** round for its market — a pagination gap or partial fetch must never mass-mark rows as gone. Track round completeness per market before trusting absences.
  - Seen→gone→seen again must **clear** the state, not accumulate.
- **Honesty label:** disappearance ≠ sale (sellers delist unsold goods). Every surfaced signal says "likely gone" / "sold or delisted" — never "sold" — in embeds and on the dashboard alike.
- **Surfaces:** a badge on dashboard cards; a "selling fast" line in the daily digest for finds whose comps are vanishing; optionally a per-brand velocity stat ("12 of the last 20 Y's pieces gone within 48h").
- **Storage:** the two new columns ship with a `PIPELINE_VERSION` bump — the v1→v2 migration is free via the existing recompute machinery.

**Exit gate.** Tests: the transition matrix including the seen-again clearing case and a pagination-gap simulation (must not mark anything). Live: watch one real auction close and see the badge/digest line appear with the honest label.

---

## Sequencing and scope boundary

**FX → accessibility → velocity.** FX and a11y are small, self-contained, single-file-cluster units that clear the runway fast; velocity is the substantive one. (A finding from drafting: the a11y unit shrank from S–M to S once contrast was actually measured — the dashboard already passes AA everywhere; only semantics remain.) Each unit goes through the standard pipeline: branch → tests where possible → PR → `ci` + `docker` → merge on green.

**Deliberately parked (not v0.4.0):** scheduled deal re-alerts, price-drop history charts, multi-user auth, non-Discord notification surfaces. None has an owner or a PR; adding scope mid-cycle without one is how releases slip.

**Definition of done for v0.4.0:** all three units merged through the pipeline, suite + drift smoke green, nightly image smoke passing on `main`, release notes drafted from the changelog the way v0.3.0's were, tag pushed with the image auto-attached and verified.
