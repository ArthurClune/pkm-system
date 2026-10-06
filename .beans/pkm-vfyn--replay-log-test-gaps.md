---
# pkm-vfyn
title: 'Replay log: test gaps'
status: in-progress
type: task
priority: normal
created_at: 2026-10-05T20:49:55Z
updated_at: 2026-10-06T09:44:38Z
---

Guard rules in the replica replay rebase that a mutation could remove with no unit test failing (deferred minors from the pkm-j3ui review):
- [x] A unit test isolating dropStrandedLocalPages' replay_log pre_page_id keep clause (and the replay_log_refs target clause): no test calls the sweep directly today.
- [x] A rewind test of a row restored by step 1 under a parent restored by step 2.
- [x] Every rewind.test.ts test asserts ftsIntact() (13 tests, 8 calls today).
- [x] The enqueue guard tested with a legacy effect_ledger table present alongside replay_log (db.test.ts only asserts its absence).
- [x] The pruneGraph gap in web/src/props/ops (compare/example).
Mutation-check each new test against the clause it pins.
