---
# pkm-gtov
title: 'Offline sync: sqlite-wasm replica worker + bootstrap + feed application'
status: todo
type: task
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-12T17:38:43Z
parent: pkm-y8p0
blocked_by:
    - pkm-dnl6
---

Spec step 3 (docs/superpowers/specs/2026-07-12-offline-editing-design.md section 3): sqlite-wasm in a dedicated worker (opfs-sahpool VFS), base-schema DDL artifact exported from schema.py BASE_DDL, bootstrap from /api/sync/snapshot, changes-feed application in order pages -> blocks -> refs -> tombstones, cursor persistence, WS seq-nudge-driven pulls while online, reset:true handling (guarded rebootstrap). Needs its own written plan before implementation.
