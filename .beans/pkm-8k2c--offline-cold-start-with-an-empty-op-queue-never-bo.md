---
# pkm-8k2c
title: Offline cold start with an empty op queue never bootstraps the replica
status: completed
type: bug
priority: normal
created_at: 2026-09-02T03:41:21Z
updated_at: 2026-09-02T04:15:58Z
---

Found by the pkm-fgjg final whole-branch review (2026-09-02). Pre-existing at 7019e7b, not introduced by the epic, but easier to hit now that pkm-gw5r suppresses the stall-retry timer while offline.

## Symptom
A first-ever load while offline with an empty op queue runs `startupRun()` but never begins a reconnect run, so the replica is never bootstrapped and views stay empty until a manual reload once online.

## Where
`web/src/sync/useSocketLifecycle.ts` (first-connect chain, ~:86-89): `reconnect.begin({ viewsAreStale: true })` is gated on `initialPending > 0` alone.

## Fix sketch
Gate on `n > 0 || !replicaUsable` (or "replica has no snapshot yet") rather than pending count alone. Unit test with fake timers: offline cold start, empty queue, then `online` → replica bootstraps without a reload.

## Checklist
- [x] Failing test for offline cold start with empty queue
- [x] Widen the first-connect gate
- [x] `sync-and-offline.md` startup sequence note
