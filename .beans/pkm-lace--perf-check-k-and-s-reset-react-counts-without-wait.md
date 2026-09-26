---
# pkm-lace
title: 'Perf check: K and S reset React counts without waiting for quiet'
status: todo
type: bug
created_at: 2026-09-26T14:07:17Z
updated_at: 2026-09-26T14:07:17Z
---

## Gap

In `web/tooling/perf/check.mjs`, K (`drag()`) and S (`search()`) reset
the React commit counters (`window.__reactReset()`) straight after
navigating/scrolling or focusing, without waiting for React to go quiet.
J had the same shape and occasionally counted a late commit from the
click/caret placement as typing; it was fixed by `reactQuiet()` before
the reset (commit 0a390e1). K and S can race the same way — roughly the
same rare rate that slipped past J's first bootstrap.

## Fix

Call `await reactQuiet(page)` before each `__reactReset()` in `drag()`
and `search()`, then re-record the frontend baseline with
`perf/check.sh frontend --bootstrap` (several runs) and confirm two
further checks pass.

Found in the final review of pkm-q1hh (M5).
