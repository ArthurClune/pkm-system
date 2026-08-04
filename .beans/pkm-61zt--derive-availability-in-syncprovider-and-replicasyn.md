---
# pkm-61zt
title: Derive availability in SyncProvider and replicaSync; delete the probe
status: todo
type: task
created_at: 2026-08-04T12:54:38Z
updated_at: 2026-08-04T12:54:38Z
parent: pkm-q2jj
---

SyncProvider learns unavailability from poisonedBatches()'s typed rejection. Deletes the init() viability probe, the `probe === "unknown"` branch, markUnavailable(), and replicaSync's `disabled` boolean. The session-commitment moment is not lost, it MOVES to the worker latch where the commitment actually happens. `unreachable` must hold the barrier (couldn't ask is not evidence there is no poison); only `unusable` lifts it.

Part of epic pkm-q2jj. Design: docs/superpowers/specs/2026-08-04-replica-availability-single-owner-design.md
