---
# pkm-87w0
title: 'Server ops tidy: plan_op returns the classification, conflict_notes split, per-kind contexts, MissingTarget rename, test hygiene'
status: in-progress
type: task
priority: low
created_at: 2026-09-29T13:20:54Z
updated_at: 2026-09-29T20:03:58Z
parent: pkm-a4t2
---

Review § Maintainability and § Tests (shape). `ops_core.py` grew from 355
to 742 lines with four pure concerns (hashing, header and label text, rename
replay and text classification, the missing-target family) before the planner
at 651; `classify_missing_target` runs three times per op with agreement by
construction, unpinned; `OpContext` is one 16-field mostly-optional bag
guarded by four "conflict context missing" 400s, and a shell slip there
poisons a client queue. Vocabulary drift: `MissingTargetKind` has six values
and `move_cycle` is not a missing target; "skipped" names a kind, an ack list
that also holds no-ops and diverted creates, and the CLI wording;
`unusable` / `unavailable` / `unreachable` are three words for two values
plus a latch; `applied` counts skipped ops and every reader subtracts.

Scope: `plan_op` returns the classification and the shell carries it;
`conflict_notes.py` (and possibly `ops_hash.py`) split out; per-kind
contexts; `MissingTarget` family rename. Test hygiene: `describe` grouping in
the flat web test files; `apply.test.ts` groups named by behaviour, not bean
id; stale comments in `opQueue.replica.test.ts` (the removed count rule),
`queue.test.ts` (byte-identical lane copies, false since pkm-95ss),
`test_ops_core.py` (an unneeded `conflict_uid`).

Bounded refactors; no spec. After the fixes in this epic land.


## Checklist

- [x] ops_hash.py split
- [x] conflict_notes.py split
- [x] MissingTarget family renamed (Skip, orphan_structural)
- [ ] Per-kind contexts carry the shell's one classification
- [ ] Docs updated
- [ ] Stale test comments; apply.test.ts groups named by behaviour
- [ ] describe grouping in the flat web test files
- [ ] Verification; findings recorded in the report
