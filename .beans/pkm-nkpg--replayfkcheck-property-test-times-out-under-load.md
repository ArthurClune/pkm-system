---
# pkm-nkpg
title: replayFkCheck property test times out under load
status: todo
type: bug
created_at: 2026-10-19T13:33:40Z
updated_at: 2026-10-19T13:33:40Z
---

`web/src/replica/replayFkCheck.test.ts`, "no hit implies the batch added no foreign_key_check key", runs `fc.assert` with `numRuns: 3000`. It takes about 2.2 s alone, against vitest's default 5 s test timeout. Under a loaded machine (parallel agents' suites, 2026-10-19) it timed out in two separate `test:coverage` runs, then passed alone and on every rerun. With the unit run expected to be completely clean, a load-only failure is noise that hides real ones.

- [ ] Decide: give the property an explicit, reasoned timeout, or cut its cost (fewer runs, a cheaper per-run DB reset) while keeping the case rates it needs (label them with `fc` statistics or counters and read them)
- [ ] Confirm under load (e.g. the full unit run beside another suite) that it no longer times out
