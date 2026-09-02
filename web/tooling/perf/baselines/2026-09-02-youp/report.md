# Frontend perf re-measurement — textarea auto-resize (pkm-youp)

**Date:** 2026-09-02 · repo `.worktrees/perf-fgjg` on `worktree-perf-youp`
· before: HEAD `24c192c` (unmodified) · after: same commit + this branch's
uncommitted changes at measurement time · baseline for comparison:
`../2026-09-01/report.md` (`5e68dd6`, "Per-keystroke cost, derived from F").

## Commands run

Before: stashed the working-tree changes (`git stash -u`) to measure `24c192c`
verbatim, then popped the stash back before building "after".

```sh
cd web && CI=true pnpm build
cd server && E2E_PORT=8977 uv run python tests/e2e_serve.py &
cd web/tooling/perf && node seed.mjs
DUR=60000 node perf.mjs F
node summarize.mjs
pkill -f tests/e2e_serve.py
```

Run twice: once against the stashed (pre-fix) tree, once against the fix.
Each run reseeded a fresh throwaway DB, matching the recipe.

## Headless/headed

Neither run set `HEADLESS`, so both are **headed** Chromium — same fidelity
as the 2026-09-01 baseline, `cpu%` included.

## Headline metrics: before -> after

| metric | before (this run) | after (this run) | 2026-09-01 baseline | verdict |
|---|---|---|---|---|
| layouts/keystroke | 3.00 | **1.00** | 3 | target met exactly (checklist: 3 → ≤1) |
| style recalcs/keystroke | 2.00 | **0.005** | 2 | effectively eliminated |
| task ms/keystroke | 6.72 | **5.63** | 6.6 | improved ~16% |
| script_s/min | 0.816 | 0.79 | — | unchanged, as expected (this is a layout fix, not a scripting one) |
| cpu% (scenario F, sustained typing) | 21.6 | 18.4 | 19.9 | improved |
| srv% | 0.27 | 0.28 | 0.21 | unchanged, as expected |

`before.json` / `after.json` are the raw `perf.mjs` output for scenario F;
figures above are read straight off `summarize.mjs`'s table (`layouts/min`
827.6 after ÷ (200 keystrokes × 60/14.5s) = 1.00/keystroke; `styles/min` 4.1
after vs. 1647.9 before).

## Correction: this run measured the CSS-only path, not the JS fallback

Playwright's bundled Chromium here is **149.0.7827.55** — well past the 123
threshold where `field-sizing` shipped — and a direct check
(`page.evaluate(() => CSS.supports("field-sizing", "content"))`) confirms it
returns `true` in this browser. So `supportsFieldSizing` is `true` and the
whole JS effect in `useBlockDraft.ts` returns immediately without running;
the "after" numbers above are the browser's **native** auto-grow, not the
`textareaHeight.ts` fallback logic. The fallback path (what the unit tests
exercise) was not exercised by this browser-driven measurement at all — a
genuinely old-Chromium/Firefox run would be needed for that, and none was
available in this environment.

This changes the read on "1 layout/keystroke, not 0": that appears to be
the true floor for *any* implementation, native or JS. Changing a
textarea's content requires at least one layout pass to determine its new
render size regardless of who's driving the resize, so 1/keystroke standing
even with zero JS on this code path is consistent, not evidence that
something is still forcing extra layout.

## Did not improve / needs a caveat

- Task time per keystroke dropped ~16%, not in proportion to the layout
  count dropping 3x. The remaining ~5.6 ms/keystroke is not layout-free: one
  layout pass per keystroke is unavoidable (see above), and the rest is
  React's render pass and the debounce bookkeeping in `useOutline.ts`,
  untouched by this change.
- The brief's third idea (`contain: layout` / `content-visibility` on
  sibling day sections) was explicitly out of scope for this task; it was
  not implemented and not measured.
- The JS fallback path (`textareaHeight.ts`'s decision logic, wired through
  `useBlockDraft.ts` when `field-sizing` is unsupported) has unit-test
  coverage but no browser-driven perf measurement in this pass, since this
  machine's Chromium supports `field-sizing` and always takes the CSS path.

## field-sizing browser support (checked 2026-09-02, via caniuse)

`field-sizing` is supported in Chrome/Edge 123+, Firefox 152+, and **Safari
26.2+ on both desktop and iOS/iPadOS**. That covers the "focused block = raw
textarea on iPad" surface this project cares about — Safari's iPadOS support
landed well before this task, so the CSS-only path should already be live
for iPad users on a current OS. `useBlockDraft.ts`'s
`CSS.supports("field-sizing", "content")` check picks this up automatically;
no user-agent sniffing needed.

## Files

`before.json` / `after.json` (perf.mjs scenario F, raw). No `ws-probe.json`
here — this task's fix has nothing to do with the sync/reconnect path.
