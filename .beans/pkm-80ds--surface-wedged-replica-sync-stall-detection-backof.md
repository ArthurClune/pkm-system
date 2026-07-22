---
# pkm-80ds
title: 'Surface wedged replica sync: stall detection, backoff, banner + reset action'
status: todo
type: bug
priority: high
created_at: 2026-07-22T10:12:47Z
updated_at: 2026-07-22T10:12:47Z
---

Fix A of docs/superpowers/specs/2026-07-22-sync-hardening-design.md (incident bean pkm-8uld). pullLoop swallows all errors -> cursor freezes forever invisibly (Mac stuck at seq 3911). Add stall detection (3 consecutive failed/no-progress pulls; pending-changed cap 20/loop), backoff retries (1s..60s), new ReplicaState 'stalled', SyncProblem 'replica-stalled' banner with Reset local data action reusing runRecovery('reset', {flush:true}) with failed-flush confirm.
