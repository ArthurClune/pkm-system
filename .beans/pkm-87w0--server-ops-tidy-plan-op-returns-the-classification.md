---
# pkm-87w0
title: 'Server ops tidy: plan_op returns the classification, conflict_notes split, per-kind contexts, MissingTarget rename, test hygiene'
status: completed
type: task
priority: low
created_at: 2026-09-29T13:20:54Z
updated_at: 2026-09-29T20:19:41Z
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
- [x] Per-kind contexts carry the shell's one classification
- [x] Docs updated
- [x] Stale test comments; apply.test.ts groups named by behaviour
- [x] describe grouping in the flat web test files
- [x] Verification; findings recorded in the report


## Summary of Changes

- `server/src/pkm/server/ops_hash.py` (Core): the `applied_batches` request hashes, moved out of `ops_core.py`.
- `server/src/pkm/server/conflict_notes.py` (Core): `[[conflict]]` header labels and skip-note text; `block_missing_note(op)` replaces `skipped_note(_SKIPPED_WHAT[type(op)], uid)`.
- Skip family: `MissingTarget` -> `Skip`, `MissingTargetKind` -> `SkipKind`, `classify_missing_target` -> `classify_skip`, `_plan_missing_target` -> `_plan_skip`; the kind `skipped` -> `orphan_structural`. Internal names only.
- Per-kind contexts: the 16-field `OpContext` bag is now a union of ten small frozen contexts with required fields, plus `ConflictLanding` (`ExistingHeader` | `FreshHeader`). `ops_apply._context_for` classifies each op once and the context carries the result into `plan_op` and `skip_report`; classification ran three times per op before. The four "conflict context missing" 400s, `_conflict_landing_ready` and the landing asserts are gone; a context that does not fit its op is an AssertionError (500), not a 400. Deviation: `plan_op` does not return the classification; the shell's one classification is carried instead.
- No wire or behaviour change: openapi dump identical; a 70-case golden battery (acks, error bodies, WS broadcasts, blocks, pages, journal, conflict_headers, refs, applied_batches) byte-identical to main.
- Docs: backend.md module map, write-path diagram and a note on the per-kind contexts; renamed identifiers across backend, sync-and-offline, sync-recovery, performance-checks and troubleshooting.
- Test hygiene: stale lane-ordering comments in opQueue.replica.test.ts and the byte-identical claim in queue.test.ts corrected; apply.test.ts groups named by behaviour; SyncProvider.test.tsx, opQueue.replica.test.ts and replicaSync.test.ts grouped into 40 describe blocks (same 229 tests); test_ops_core.py restructured onto the new contexts (the unneeded conflict_uid seed went with the bag).
- Findings left for Arthur (not changed): `applied` counts skipped ops; the unusable/unavailable/unreachable vocabulary.
