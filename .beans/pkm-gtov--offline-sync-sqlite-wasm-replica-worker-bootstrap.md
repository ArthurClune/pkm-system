---
# pkm-gtov
title: 'Offline sync: sqlite-wasm replica worker + bootstrap + feed application'
status: todo
type: task
priority: normal
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-12T18:46:09Z
parent: pkm-y8p0
blocked_by:
    - pkm-dnl6
---

Spec step 3 (docs/superpowers/specs/2026-07-12-offline-editing-design.md section 3): sqlite-wasm in a dedicated worker (opfs-sahpool VFS), base-schema DDL artifact exported from schema.py BASE_DDL, bootstrap from /api/sync/snapshot, changes-feed application in order pages -> blocks -> refs -> tombstones, cursor persistence, WS seq-nudge-driven pulls while online, reset:true handling (guarded rebootstrap). Needs its own written plan before implementation.

## Carry-forward from pkm-dnl6 final review (2026-07-12)

- Blocked additionally by pkm-o9o5 (DB generation token): rebuilt-DB detection must land before/with the replica or a stale cursor silently misses rows.
- Measure /api/sync/snapshot against the real prod-size DB before relying on it for bootstrap: hydration is N+1 (~106k point-SELECTs for 53k blocks); JOIN-based hydration is a contained change if too slow.
- Conflict-copy blocks are not in the WS batch broadcast (only request-form ops are). Live tabs miss them until refetch/feed pull — replica must consume seq nudges + feed, not rely on op broadcasts, for conflict visibility.
