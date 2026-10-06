---
# pkm-ib6j
title: 'Replay rebase: per-batch whole-database foreign_key_check dominates window cost'
status: completed
type: task
priority: normal
created_at: 2026-10-06T08:57:51Z
updated_at: 2026-10-06T10:31:20Z
---

Perf scenario R (perf/check.sh frontend, `R/rebase-*`) shows that about 96% of each feed window's SQLite VM work, when batches are pending, is `replayPending`'s whole-database `PRAGMA foreign_key_check` (`fkViolations` in `web/src/replica/apply.ts`). It runs K+1 times per window for K pending batches: 7 times, about 3.7k of 3.9k `vm_steps_k`, per window on the 50k-block fixture. The cost grows with replica size times queue length, and it is paid on every window while anything is pending (offline catch-up is the worst case).

The comment on `fkViolations` explains why the check is unscoped: scoping to `blocks` alone would miss `refs`/`block_refs`, and a check scoped to all three tables costs the same. The open question is a different shape: check only the rows a batch could have dangled (the blocks and refs its replay touched, via the replay log or savepoint-scoped tracking), or skip the per-batch check when the batch's ops cannot create a dangling FK. Either must keep the invariant in sync-recovery.md ("A re-applied pending batch dangles a foreign key → that batch rolls back locally; its row stays").

- [x] Design: which rows a batch can dangle, and how to enumerate them cheaply; the argument that the narrowed check sees every violation the whole-database check would
- [x] Adversarial review of that argument
- [x] Implement with tests on the FK-hazard cases (`applyFkHazards.test.ts`)
- [x] `perf/check.sh frontend`: R's `vm_steps_k` should drop sharply (an improvement ratchets the baseline)
- [x] `proptest/check.sh web` (sync touches replay)

## Summary of Changes

replayPending no longer runs a whole-database PRAGMA foreign_key_check before and after every pending batch. Each replayed batch is screened by targetedFkHit, one indexed query over the rows the batch's replay-log records name (PAGE: a block on a recorded page that is missing; CHILD/REFS/BREFS: dependants of a recorded block that is gone, reachable only on the FKs-off reset rebuild). A hit rolls the batch back to its savepoint and runs exactly the old per-batch logic, with the whole-database baseline taken there, so outcomes are unchanged. The claim (an empty targeted check means no new violation) passed an adversarial review (0 misses in ~110k random trials) and is pinned by a fast-check property over FKs on/off, dangling baselines, NULL and comma uids; each clause has a mutation-checked unit test, and a schema-pin test fails when a table gains an FK. The old rowid-reuse test (which pinned nothing) was rebuilt on the page FK; a vacuous reset-path test was deleted.

Perf: R's vm_steps_k per window ~3.9k -> ~175 (-96%) in all three windows, statements -1; baseline ratcheted. proptest/check.sh web 68/68. Side finding filed as pkm-cyb2.
