# Contributing to SwagScout

Thanks for your interest in contributing. This guide covers what you need
to know to land a change in `main`: the local gates, the branch/PR flow,
and the few non-obvious conventions this codebase enforces in tests.

## Prerequisites

- **Node.js 24.x LTS** (any Node 23+ runtime works — the store uses the
  built-in `node:sqlite`, so there is no native compile step).
- `npm install` after cloning.

## Local gates (run before every push)

```bash
npm run typecheck   # tsc --noEmit — must report 0 errors
npm run build       # must compile clean
npx vitest run      # full suite must pass; it is kept green at all times
```

If you added or removed tests, update the counts in the PR description —
the suite is currently **360 tests across 39 files**, and PR
descriptions state the numbers so reviewers can spot accidental
deletions.

## Branch and PR flow

1. Branch from an up-to-date `main` with a descriptive name
   (`feat/…`, `fix/…`, `docs/…`).
2. Stage **explicit files only** (`git add path/to/file`) — never
   `git add -A`.
3. Commit with a title that states the change and a body that states the
   *why*, one short paragraph per logical unit, ending with the tests
   and validation evidence.
4. Push and open a PR against `main`. The description should cover what
   changed, why, and how it was verified (unit tests plus any live
   verification against real data).
5. Wait for **both** required checks to pass on your exact head commit —
   `ci` (typecheck, build, unit tests) and `docker` (image build).
   Statuses on an older commit don't count.
6. Squash-merge once green. The squash title carries the PR number:
   `Title of the change (#N)`.
7. Delete the head branch **after** the PR is verified merged — as its
   own step, never chained onto another command with silenced output
   (`2>/dev/null`, `|| true`). A silenced, chained mutation is how
   mistakes become invisible; if a delete runs, its result should be
   printed and checked (a `204`, then a `404` when you re-check the
   branch), not assumed.
8. Sync `main` and prune your local branch; `git status --short` should
   print nothing before you start the next unit.

## Code conventions the tests enforce

These are not style preferences — they are pinned by tests, and a PR
that breaks them does not merge:

- **Marketplace-adjacent data never touches markup.** Anything derived
  from marketplace titles/URLs is rendered through the escaping helpers
  or written via `textContent` / DOM APIs — never concatenated into
  `innerHTML` (see `tests/inner-html-guard.test.ts`).
- **Server-computed template ternaries need an explicit allowlist entry
  with a comment** in that guard test explaining why the interpolation
  is safe.
- **A11y contract:** every filter control carries an `aria-label`;
  images carry `alt`; connection state is announced through a polite
  live region, not color alone; ambient animation respects
  `prefers-reduced-motion` (see `tests/dashboard-a11y.test.ts`).
- **Pipeline-version honesty:** if a change recomputes brand/size/deal
  fields that stored rows may have recorded under an older pipeline,
  bump `PIPELINE_VERSION` in `src/core/pipeline.ts` so the app can
  recompute (see `src/app.ts` for the bump semantics).
- **No fabricated counts.** Wire payloads report real post-filter totals
  (e.g. `matched` vs the rendered `shown` page), and honest framing
  applies to derived metrics too — absence is not proof of sale.

## Running the app locally

```bash
npm run dev        # tsx on src/index.ts — reflects the working tree
```

The dashboard serves on `http://127.0.0.1:3080` by default. No secrets
are required: without a Discord token/webhook the app logs alerts
instead of sending them, which is the right mode for development.
`data/swagscout.db` is gitignored; an absent database is not an error —
the bot creates one on boot and fills it by polling.

## PR checklist

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run build` — clean
- [ ] `npx vitest run` — full suite green; counts updated in the PR body
- [ ] Explicit files staged; no unrelated changes swept in
- [ ] New template interpolations either escaped or allowlisted in the
      inner-HTML guard test
- [ ] New UI passes the a11y contract (labels, alt, live regions,
      reduced motion)
- [ ] `PIPELINE_VERSION` bumped if stored fields changed meaning
- [ ] Both required checks green on the head commit before merge
- [ ] Head branch deleted after merge — as a separate, verified step
