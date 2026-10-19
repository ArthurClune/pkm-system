---
# pkm-nkpg
title: replayFkCheck property test times out under load
status: completed
type: bug
created_at: 2026-10-19T13:33:40Z
updated_at: 2026-10-19T13:33:40Z
---

`web/src/replica/replayFkCheck.test.ts`, "no hit implies the batch added no foreign_key_check key", runs `fc.assert` with `numRuns: 3000`. It takes about 2.2 s alone, against vitest's default 5 s test timeout. Under a loaded machine (parallel agents' suites, 2026-10-19) it timed out in two separate `test:coverage` runs, then passed alone and on every rerun. With the unit run expected to be completely clean, a load-only failure is noise that hides real ones.

- [x] Decide: give the property an explicit, reasoned timeout, or cut its cost (fewer runs, a cheaper per-run DB reset) while keeping the case rates it needs (label them with `fc` statistics or counters and read them)
- [x] Confirm under load (e.g. the full unit run beside another suite) that it no longer times out

## Summary of Changes

Decision: an explicit 30 s per-test timeout, with numRuns kept at 3000.

Measured (this machine, unloaded): 1.4 s alone, 2.2 s under `--coverage`;
9.5 s inside a full `pnpm test:coverage` with 20 `yes` busy loops on 10 cores
(past the old 5 s default, so the failure reproduces and is now fixed). Per
run cost over 3000 runs: replay 0.38 s, targetedFkHit 0.09 s, the two
foreign_key_check calls 0.04 s each; the rest is scenario setup and
generation, so there is no cheap reset to take.

Case rates at 3000 runs: targetedFkHit false 2862 (95%); hit 137; batch added
a foreign_key_check key 23 (0.8%, every one a hit); among no-hit runs fksOff
1391, dangling baseline 1468, ghost refs 746, comma-uid ops 1052, NULL-uid ops
334, shared batch id 1339. Rates scale linearly (23 added at 3000, 8 at 1000).

Why runs were not cut: teeth at 3000 runs, six seeds each. Always-false and
dropping the PAGE clause fail in 86 to 319 runs on every seed. Dropping the
CHILD clause failed on only 1 of 6 seeds (run 2811); a subtler PAGE mutant
caught on 4 of 6 (runs 319 to 2416). The property is already marginal for
CHILD, so fewer runs would weaken it. A generator that reaches CHILD more
often is worth a follow-up.
