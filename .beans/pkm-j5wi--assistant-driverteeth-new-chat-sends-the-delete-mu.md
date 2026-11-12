---
# pkm-j5wi
title: 'assistant driverTeeth: ''New chat sends the DELETE'' mutant caught by the wrong rule under a full web proptest run'
status: completed
type: bug
priority: normal
created_at: 2026-11-12T17:25:07Z
updated_at: 2026-11-12T20:13:52Z
---

In a full `proptest/check.sh web` run on 2026-11-12, `src/props/assistant/driverTeeth.prop.ts` failed one test:

`× the assistant driver property catches: New chat sends the DELETE before the aborted stream settles` → `mutant caught, but not by delete (seed -1934688392): ... quiet: still outstanding after settling: , 2 timers, 0 409s: expected false to be true`

The same suite passes alone at both 3cfc7d41 and the pkm-3ono branch head, and replaying `--seed -1934688392` passes on both. So it depends on load or timing in the full run (fake timers left outstanding), not on the drawn commands. Per AGENTS.md, a property that fails and then passes on the same seed gets a bean against the gate.

- [x] Reproduce under load (full web run, or the suite beside a CPU-heavy one)
- [x] Find why two timers are still outstanding at the quiet check
- [x] Fix the harness or the rule, with the reason in the commit

## Another occurrence (2026-11-12)

Full web run from the 3kwx-stall-behind-poison worktree: assistant/driverTeeth.prop.ts 'an old stream's event is dispatched for the turn busy when it arrives' -> mutant caught, but not by agree (seed -759678055). Rerun on that seed: 15/15 pass. Same pattern as above, a different test.

## Summary of Changes

Reproduced on the same full run (2026-11-12): 'quiet: still outstanding after settling: , 2 timers' on driverTeeth's first test. Cause: waitUntil (web/src/props/sync/steps.ts) raced a polling loop against within(), so a wait that timed out left its loop polling every 5 ms for the rest of the process. settleTeeth's timed-out waits leave such loops; in the shared process they put re-arming timers on driverTeeth's fake clock, which the quiet check counted and whose advances displaced the driver's own (also the 'not by agree' occurrence). Shown with a probe after settleTeeth: about 200 timers in 2 s from steps.ts.

Fixes: waitUntil stops polling once its time is up (steps.test.ts, which fails against the old version), and sync.prop.ts's three hand-written within(poll loop) waits use it. Each props file now runs in its own process (see pkm-mgc0), so no file's leftovers reach another.
