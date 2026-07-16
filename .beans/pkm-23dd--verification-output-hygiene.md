---
# pkm-23dd
title: Verification output hygiene
status: completed
type: task
priority: normal
created_at: 2026-07-16T12:08:59Z
updated_at: 2026-07-16T13:32:25Z
---

Practical diagnostics triaged by the pkm-c1cg final review as worth silencing (the SQLite FK diagnostic and Node experimental localStorage warning were triaged ACCEPT as intrinsic):

- [x] Add a catch-all route to the TopBar test render (TopBar.test.tsx ~line 170) to silence the unmatched /current-work route message.
- [x] Set build.chunkSizeWarningLimit now that hard byte budgets supersede Vite's advisory warning.
- [x] Fix the Playwright NO_COLOR / FORCE_COLOR env conflict warning.

## Summary of Changes

1. **TopBar.test.tsx**: added a catch-all `<Route path="*" .../>` to
   `renderTopBar`'s router alongside `/` and `/page/*`, since `/current-work`
   (used by the "labels the current-work route in the bar" test) wasn't
   matched by either, causing react-router to log "No routes matched
   location". Verified the message is gone from `pnpm test:unit` output and
   all 18 tests in the file still pass.

2. **vite.config.ts**: set `build.chunkSizeWarningLimit: 900` (kB) with a
   comment explaining the hard byte budgets in `tooling/budgets.json`
   (enforced by `budgetPlugin()`, which fails the build on regression) now
   supersede Vite's advisory >500kB warning. 900kB sits just above the
   current largest chunk (`largestAssetBytes: 907990` raw ≈ 887kB is the
   sqlite3 wasm asset itself, which Vite's own warning doesn't cover as a
   "chunk"; the largest *JS chunk*, cynefin, is ~691kB) and below the
   sqlite3 wasm size. Confirmed via `pnpm build` that no chunk-size warning
   appears, while `budgetPlugin`'s own "precache budget report: OK" still
   runs and would still fail the build on a real regression.

3. **Playwright NO_COLOR/FORCE_COLOR warning**: root-caused to Node's own
   runtime behavior (not Playwright, and not anything previously in this
   repo) — Node prints "Warning: The 'NO_COLOR' env is ignored due to the
   'FORCE_COLOR' env being set." in *every* node process it spawns whenever
   both vars are present in that process's environment (confirmed by
   reproducing locally with `NO_COLOR=1 FORCE_COLOR=1`). Neither var is set
   anywhere in this repo (playwright.config.ts, package.json scripts,
   .npmrc) — the conflict comes from whatever the calling shell happens to
   export. A fix placed inside `playwright.config.ts` was tried first but
   only partly worked: Playwright's own CLI process (and something in its
   startup, before user config loads) already triggers the warning before
   config.ts's module code runs, so only *later*-forked processes (workers,
   the webServer) picked up the fix. Replaced that with
   `web/tooling/runPlaywright.mjs`, a thin wrapper (pattern: Imperative
   Shell) that deletes `NO_COLOR` from its own copy of `process.env` when
   `FORCE_COLOR` is also present (mirroring Node's own precedence) *before*
   spawning `pnpm exec playwright test`, so the playwright CLI and its
   entire process tree inherit the already-resolved environment from their
   very first line. `package.json`'s `e2e` and `verify` scripts now call
   `node tooling/runPlaywright.mjs` instead of `playwright test` directly.
   Verified: `NO_COLOR=1 FORCE_COLOR=1 node tooling/runPlaywright.mjs ...`
   produces zero warnings (down from 2-3 depending on approach) and correct
   colorized output; `NO_COLOR=1` alone still produces plain (uncolored)
   output; `FORCE_COLOR=1` alone is untouched — only the actual conflict is
   resolved, not either single-var case.

Acceptance verified: `pnpm test:unit` (1022 tests) shows no TopBar route
message and is otherwise unchanged; `pnpm verify` passed end-to-end
(typecheck, lint, check:fcis, coverage-enforced unit tests, `vite build`
with budgets OK and no chunk-size warning, and Playwright 7/7) with no
color-conflict warning in the log. No flake observed in the
offline-shell cold-start E2E (pkm-ss9k) during this run.
