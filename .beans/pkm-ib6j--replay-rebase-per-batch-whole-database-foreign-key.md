---
# pkm-ib6j
title: 'Replay rebase: per-batch whole-database foreign_key_check dominates window cost'
status: in-progress
type: task
priority: normal
created_at: 2026-10-06T08:57:51Z
updated_at: 2026-10-06T10:19:01Z
---

Perf scenario R (perf/check.sh frontend, `R/rebase-*`) shows that about 96% of each feed window's SQLite VM work, when batches are pending, is `replayPending`'s whole-database `PRAGMA foreign_key_check` (`fkViolations` in `web/src/replica/apply.ts`). It runs K+1 times per window for K pending batches: 7 times, about 3.7k of 3.9k `vm_steps_k`, per window on the 50k-block fixture. The cost grows with replica size times queue length, and it is paid on every window while anything is pending (offline catch-up is the worst case).

The comment on `fkViolations` explains why the check is unscoped: scoping to `blocks` alone would miss `refs`/`block_refs`, and a check scoped to all three tables costs the same. The open question is a different shape: check only the rows a batch could have dangled (the blocks and refs its replay touched, via the replay log or savepoint-scoped tracking), or skip the per-batch check when the batch's ops cannot create a dangling FK. Either must keep the invariant in sync-recovery.md ("A re-applied pending batch dangles a foreign key → that batch rolls back locally; its row stays").

- [x] Design: which rows a batch can dangle, and how to enumerate them cheaply; the argument that the narrowed check sees every violation the whole-database check would
- [x] Adversarial review of that argument
- [x] Implement with tests on the FK-hazard cases (`applyFkHazards.test.ts`)
- [ ] `perf/check.sh frontend`: R's `vm_steps_k` should drop sharply (an improvement ratchets the baseline)
- [ ] `proptest/check.sh web` (sync touches replay)
