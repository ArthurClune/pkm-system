---
# pkm-996z
title: 'Property gate: a synchronous web property past 60 s fails the run with a vitest RPC timeout'
status: todo
type: bug
created_at: 2026-11-08T14:36:08Z
updated_at: 2026-11-08T14:36:08Z
---

## Symptom

`proptest/check.sh web --file outline` exits 1 with `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` (an unhandled error) although every test passed, and the files after outline.prop.ts are not reported. Seen twice on 2026-11-08 under machine load (load average 6 to 14), when outline.prop.ts took 61.6 s and 77.4 s; clean when it took 53 s.

## Cause

vitest's worker RPC (birpc) times out a call after 60 s. outline.prop.ts runs `fc.check` synchronously, budgeted at about 50 s (NUM_RUNS) with a 90 s time limit, so it blocks the worker's event loop; when it runs past 60 s, the timeout timer fires before the RPC reply is read. A plain 62 s busy-loop test in `web/src/props` reproduces it, so it is the gate's, not a product bug.

## Fix ideas

- [ ] Yield to the event loop inside long properties (fc.asyncProperty, or chunked fc.check runs), or
- [ ] Size synchronous budgets well under 60 s, with the time limit below it too, and say why beside NUM_RUNS
- [ ] checks.md § Property gate: the rule a web property must keep
