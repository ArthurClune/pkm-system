---
# pkm-996z
title: 'Property gate: a synchronous web property past 60 s fails the run with a vitest RPC timeout'
status: completed
type: bug
priority: normal
created_at: 2026-11-08T14:36:08Z
updated_at: 2026-11-08T17:53:23Z
---

## Symptom

`proptest/check.sh web --file outline` exits 1 with `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` (an unhandled error) although every test passed, and the files after outline.prop.ts are not reported. Seen twice on 2026-11-08 under machine load (load average 6 to 14), when outline.prop.ts took 61.6 s and 77.4 s; clean when it took 53 s.

## Cause

vitest's worker RPC (birpc) times out a call after 60 s. outline.prop.ts runs `fc.check` synchronously, budgeted at about 50 s (NUM_RUNS) with a 90 s time limit, so it blocks the worker's event loop; when it runs past 60 s, the timeout timer fires before the RPC reply is read. A plain 62 s busy-loop test in `web/src/props` reproduces it, so it is the gate's, not a product bug.

## Fix ideas

- [x] Yield to the event loop inside long properties (fc.asyncProperty, or chunked fc.check runs), or
- [x] ~~Size synchronous budgets well under 60 s~~ (not taken: see Summary)
- [x] checks.md § Property gate: the rule a web property must keep

## Summary of Changes

`web/src/props/setup.ts` (a new setupFile of `vitest.props.config.ts`) sets a
fast-check global `asyncBeforeEach` from `props/giveWay.ts`, which yields to a
macrotask (setImmediate) once a second. While it is set, fast-check refuses to
build a synchronous `fc.property`, so the rule is enforced for every props
file. The synchronous properties (outline, assistant, journal, their teeth,
sync smoke) became `fc.asyncProperty`; arbitraries are unchanged, so seeds and
paths replay as before.

Shrinking the budgets was not taken: load stretched outline 1.55x (50 s to
77 s), so surviving it would need a budget near 35 s on every run, and a
loaded run would then fail on its own time limit instead.

Evidence: a 62 s busy-loop test reproduced the timeout; awaiting a resolved
promise per example still timed out; through setup.ts the same 62 s property
passed, and a synchronous fc.property throws. Cost, file alone, main vs
branch: outline 51.2 s vs 52.0 s, assistant 17.6 vs 18.9, journal 11.2 vs
11.3. pnpm verify and proptest/check.sh web pass.

