---
# pkm-7788
title: Local reapply rolls back a whole batch the server now applies in part
status: completed
type: bug
priority: normal
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-29T08:25:20Z
---

Found in the pkm-foap review (M3). The server now applies a batch's valid ops and skips ops on missing targets, but the replica's local apply (web/src/replica/localOps.ts) still throws "block not found" and reapplyPending rolls back the WHOLE batch. Example: pending [create C under a tombstoned ghost, update_text L] reverts L locally until the batch is acked; a follow-up edit to L in that window hashes against the reverted text and lands a spurious check-5 conflict. Short window (the queue flushes promptly online). Fix: make local apply mirror the server's missing-target rules (skip, don't throw), keeping the shim parity fixtures in step.

## Summary of Changes

- `web/src/replica/missingTarget.ts` (Core): `skipsOnMissingTarget` mirrors `ops_core.classify_missing_target`'s skip-or-not decision.
- `shared/fixtures/missing_targets.json` pins both sides: `test_ops_core.py::test_classify_missing_target_matches_shared_fixture` and `missingTarget.test.ts`. `shim_parity.json` needed no change, since it covers read payloads, not ops.
- `localOps.ts`: `applyOne` skips ops on a missing block or create/move parent instead of throwing (`requireBlock` removed) or inserting a dangling parent_uid. A create onto an existing uid and a title violation still throw.
- Regression tests in `apply.test.ts` cover the snapshot and windowed variants of the bean's scenario; both failed before the fix. `localOps.test.ts` covers every op type skipped on a missing target.
- Docs: sync-recovery.md (failure table row, § Ops on blocks the server no longer has) and frontend.md module map.
- Verified: `pnpm verify` green, server pytest/ruff/pyrefly green, `perf/check.sh` unchanged against the baselines.
- Follow-up found during the work: pkm-b0zf, where a windowed reapply rolls back a batch whose create already applied (UNIQUE).
