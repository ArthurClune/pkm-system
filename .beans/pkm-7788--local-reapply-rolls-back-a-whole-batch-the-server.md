---
# pkm-7788
title: Local reapply rolls back a whole batch the server now applies in part
status: in-progress
type: bug
priority: normal
created_at: 2026-09-28T22:40:50Z
updated_at: 2026-09-29T08:04:08Z
---

Found in the pkm-foap review (M3). The server now applies a batch's valid ops and skips ops on missing targets, but the replica's local apply (web/src/replica/localOps.ts) still throws "block not found" and reapplyPending rolls back the WHOLE batch. Example: pending [create C under a tombstoned ghost, update_text L] reverts L locally until the batch is acked; a follow-up edit to L in that window hashes against the reverted text and lands a spurious check-5 conflict. Short window (the queue flushes promptly online). Fix: make local apply mirror the server's missing-target rules (skip, don't throw), keeping the shim parity fixtures in step.
