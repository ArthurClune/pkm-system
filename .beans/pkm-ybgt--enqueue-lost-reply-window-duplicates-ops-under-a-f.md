---
# pkm-ybgt
title: Enqueue lost-reply window duplicates ops under a fresh batch id (HTTP 400 uid already exists)
status: completed
type: bug
priority: high
created_at: 2026-08-14T16:35:47Z
updated_at: 2026-08-14T16:45:53Z
---

Diagnosed 2026-08-14 from prod logs + applied_batches forensics (iPad PWA incident, batch d7a698ba).

**Symptom:** iPad home-screen PWA showed "Server rejected a change (HTTP 400)" with a create op for a block that already existed, then wedged at "17 changes pending" until the poison repair eventually completed.

**Root cause:** `opQueue.enqueue()`'s catch treats any `replica.enqueue` RPC failure as "not persisted locally" and retains the ops in the in-memory fallback lane with a freshly minted `newUid()` batch id (opQueue.ts ~line 677). But the worker HAD durably persisted the row (with its own `crypto.randomUUID()` batch id) — the reply was lost, likely to iOS suspending the PWA mid-RPC. Both copies then delivered: the lane copy first (create + update succeeded under 16-char batch ids, visible in applied_batches at 17:12:32), then the durable original → 400 `uid already exists`. The server's replay dedup is keyed on batch_id, so it cannot recognize the duplicate.

**Fix:** mint the batch id in the caller (opQueue) and pass it through to `replica.enqueue`; reuse the SAME id for the fallback-lane copy. A duplicate delivery then hits the server's applied_batches replay path (stored 200 ack, or 409 if ops differ) instead of a 400. No server changes needed.

## Tasks

- [x] Failing test: worker enqueue persists a caller-provided batch id
- [x] Failing test: lane copy retained after a lost-reply enqueue failure reuses the durable batch id
- [x] Implement: opQueue mints batch id, passes to replica.enqueue; lane copy reuses it
- [x] Worker/RPC: enqueue accepts optional batch id (mints its own when absent, for older callers)
- [x] cd web && pnpm verify (typecheck, unit coverage 2081 tests, 53 e2e — all green)
- [x] Architecture docs: sync-and-offline.md — diagram line, lane batch-id invariant, symptom-table row

## Summary of Changes

- `web/src/sync/opQueue.ts`: `enqueue()` mints the batch id with `newUid()` BEFORE the `replica.enqueue` RPC and passes it through; the fallback-lane entry retained on a persist failure reuses that id instead of minting a fresh one. A lost reply can no longer split one batch into two identities.
- `web/src/replica/client.ts`: `Replica.enqueue(ops, batchId?)`; the RPC payload is now `{ ops, batchId }`.
- `web/src/replica/workerHandlers.ts`: the enqueue handler accepts both the new object payload and the legacy bare-array payload (mints its own id for the latter).
- Tests: two new worker-handler tests (caller-provided id persisted; bare-array still minted) and a lost-reply opQueue test pinning that both POSTs carry one batch id — all watched fail first. `memReplica` honors caller ids and records them in `enqueued`; seven tests that pinned literal `batch-1` ids now read the recorded ids.
- `docs/architecture/sync-and-offline.md`: sequence diagram (batch_id stamped main-thread), the lane's batch-id invariant, and a symptom-table row for the 400-on-reconnect incident.

No server changes: the server-side replay dedup (`applied_batches`) already absorbs same-id duplicates.
