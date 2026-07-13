---
# pkm-gtov
title: 'Offline sync: sqlite-wasm replica worker + bootstrap + feed application'
status: completed
type: task
priority: normal
created_at: 2026-07-12T17:38:43Z
updated_at: 2026-07-13T19:01:38Z
parent: pkm-y8p0
blocked_by:
    - pkm-dnl6
---

Spec step 3 (docs/superpowers/specs/2026-07-12-offline-editing-design.md section 3): sqlite-wasm in a dedicated worker (opfs-sahpool VFS), base-schema DDL artifact exported from schema.py BASE_DDL, bootstrap from /api/sync/snapshot, changes-feed application in order pages -> blocks -> refs -> tombstones, cursor persistence, WS seq-nudge-driven pulls while online, reset:true handling (guarded rebootstrap). Needs its own written plan before implementation.

## Carry-forward from pkm-dnl6 final review (2026-07-12)

- Blocked additionally by pkm-o9o5 (DB generation token): rebuilt-DB detection must land before/with the replica or a stale cursor silently misses rows.
- Measure /api/sync/snapshot against the real prod-size DB before relying on it for bootstrap: hydration is N+1 (~106k point-SELECTs for 53k blocks); JOIN-based hydration is a contained change if too slow.
- Conflict-copy blocks are not in the WS batch broadcast (only request-form ops are). Live tabs miss them until refetch/feed pull — replica must consume seq nudges + feed, not rely on op broadcasts, for conflict visibility.

## Summary of Changes

Implemented on codex/pkm-offline-web (plan: docs/superpowers/plans/2026-07-13-offline-sync-web.md):
- baseSchema.gen.ts artifact exported from schema.py BASE_DDL (schema_dump.py + guard test) — server-only journal tables never reach the client.
- ReplicaDb interface over sqlite-wasm oo1 (wrapSqlite), client-only DDL (sync_client_meta, pending_ops), synchronous sha256, SCHEMA_VERSION stamp.
- apply.ts: snapshot bootstrap + windowed feed application (pages→blocks→refs→tombstones, one transaction, defer_foreign_keys, FTS maintained by base triggers, idempotent re-pulls); reset:true and generation-flip (pkm-o9o5) both request re-bootstrap.
- RPC layer (MessagePort protocol, quota flag preserved), typed Replica facade, worker shell on opfs-sahpool with no-replica degradation.
- replicaSync driver: bootstrap-if-empty, WS seq-nudge single-flight pulls with trailing coalescing, guarded rebootstrap (flush pending batches first — epic guardrail), schema-mismatch flush-then-rebuild with degraded fallback; SyncProvider wires it with reconnect ordering flush→pull→resync.
- All replica logic tested against real sqlite-wasm in Node (spiked: FTS5 works, v3.53).
- Snapshot timing measured on a prod-size DB copy: 0.49s hydrate + 0.04s serialize, 15MB JSON — N+1 hydration is fine, no JOIN rewrite needed.

Browser-level (real Worker/OPFS) verification lands with the pkm-wptk e2e scenario per the plan.
