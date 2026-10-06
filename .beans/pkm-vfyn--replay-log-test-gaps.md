---
# pkm-vfyn
title: 'Replay log: test gaps'
status: completed
type: task
priority: normal
created_at: 2026-10-05T20:49:55Z
updated_at: 2026-10-06T09:52:23Z
---

Guard rules in the replica replay rebase that a mutation could remove with no unit test failing (deferred minors from the pkm-j3ui review):
- [x] A unit test isolating dropStrandedLocalPages' replay_log pre_page_id keep clause (and the replay_log_refs target clause): no test calls the sweep directly today.
- [x] A rewind test of a row restored by step 1 under a parent restored by step 2.
- [x] Every rewind.test.ts test asserts ftsIntact() (13 tests, 8 calls today).
- [x] The enqueue guard tested with a legacy effect_ledger table present alongside replay_log (db.test.ts only asserts its absence).
- [x] The pruneGraph gap in web/src/props/ops (compare/example).
Mutation-check each new test against the clause it pins.

## Summary of Changes

Test-only. New reconcileSweep.test.ts isolates each dropStrandedLocalPages keep clause (pre_page_id, page record, replay_log_refs, blocks, refs, today's daily title, negative ids). rewind.test.ts gains a step-1 row restored under a step-2 parent, and every test now asserts ftsIntact(). workerHandlers.test.ts covers the enqueue guard with a legacy effect_ledger with and without replay_log. compare.test.ts pins pruneGraph carrying pageStamps through (the one surviving clause mutation). Each new test was mutation-checked against its clause; the ftsIntact() additions cannot be. pnpm test:unit, typecheck and proptest/check.sh web pass.
