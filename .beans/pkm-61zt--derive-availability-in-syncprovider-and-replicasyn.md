---
# pkm-61zt
title: Derive availability in SyncProvider and replicaSync; delete the probe
status: in-progress
type: task
priority: normal
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T15:57:43Z
parent: pkm-q2jj
---

SyncProvider learns unavailability from poisonedBatches()'s typed rejection. Deletes the init() viability probe, the `probe === "unknown"` branch, markUnavailable(), and replicaSync's `disabled` boolean. The session-commitment moment is not lost, it MOVES to the worker latch where the commitment actually happens. `unreachable` must hold the barrier (couldn't ask is not evidence there is no poison); only `unusable` lifts it.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md


## Finding from Task 5 review (fix round 1)

`replicaSync.test.ts`'s "markUnavailable is permanent even if a later init would succeed" never actually calls `replica.init()`: `sync.markUnavailable()` sets `disabled = true` directly, and `start()`'s first line is `if (disabled) return;`, so the fixture's `init` is dead code in this test regardless of what it would return. There is no fail-then-succeed sequence being guarded — the test's real subject is that `disabled` alone (not any re-derivation from `init()`) makes `markUnavailable()` permanent. Its name and comment describe a fixture behaviour a reader will not find if they go looking for it. Task 6 touches this exact code (deletes `markUnavailable`/`disabled`) and should account for this when it rewrites the area — confirmed by the Task 5 reviewer as correct; deliberately left unchanged in Task 5 since decorating dead code would have been worse than leaving the (accurate, if oddly-named) test alone.
