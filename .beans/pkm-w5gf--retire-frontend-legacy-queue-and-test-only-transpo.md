---
# pkm-w5gf
title: Retire frontend legacy queue and test-only transport compatibility
status: in-progress
type: task
priority: high
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:22Z
updated_at: 2026-08-18T12:11:49Z
parent: pkm-wvvu
---

## Review findings

Frontend A1, B1, and the `opQueue.runDrain` complexity finding.

`createLegacyQueue` is a second queue selected only without a replica, primarily to support jsdom tests. Additional optional batch IDs, legacy payload shapes, and optional local API dependencies keep test-double compatibility in production paths.

## Acceptance criteria

- [x] Point queue policy tests at a fake in-memory Replica and delete `createLegacyQueue` plus its duplicate dispatcher and `MAX_BATCH` — `web/src/sync/memReplica.ts` added; `createLegacyQueue`, `MAX_BATCH`, and `web/src/sync/opQueue.test.ts` (the old test-only-transport suite) are gone; policy tests now ride `web/src/sync/opQueue.replica.test.ts` against `memReplica`
- [x] Make Replica enqueue batch IDs required and remove unidentified-delivery FIFO bookkeeping — `Replica.enqueue(ops, batchId: string)` is non-optional in `web/src/replica/client.ts`; `unidentifiedDeliveries`/`unidentified` no longer appear anywhere under `web/src`
- [x] Accept only the current object enqueue payload in worker handlers — `web/src/replica/workerHandlers.ts`'s `enqueue(payload)` and `web/src/replica/client.ts`'s `rpc.call("enqueue", { ops, batchId })` are object-only, no legacy positional/array shape
- [x] Make local API dependencies required, or provide an explicit production-safe `newBatchId` default that cannot silently degrade offline creation — resolved as "required": `handleLocalApi(db: ReplicaDb, req: LocalApiRequest, deps: LocalApiDeps)` in `web/src/replica/localApi/router.ts` has no `?` on `deps`; the dead router re-export that let deps be omitted is deleted
- [x] Extract named durable rejection and lane-head delivery protocols from `runDrain`; rename the side-effecting `laneOnly` predicate — `web/src/sync/opQueue.ts` now has `deliverLaneHead`, `rejectDurableBatch`, `clearDurablePrecedence`, and `deferDurableQueue` (the former `laneOnly`); no `laneOnly` predicate remains (the one surviving occurrence, `laneOnlyReplica` in `opQueue.replica.test.ts`, is an unrelated test-fixture helper name)
- [x] Preserve fallback-lane ordering, poison retention, recovery barriers, beforeunload protection, and offline edits with regression tests — the ported policy tests in `opQueue.replica.test.ts` cover these against `memReplica`; the 51-test replica suite was untouched by this branch
- [x] Reconcile this work with active bean `pkm-tu5k` before implementation to avoid conflicting queue changes — verified: the poison-mark-intent localStorage mechanism (`POISON_MARK_INTENTS_KEY`), the start-in-recovering gate, and `retryPoisonMarks` in `web/src/sync/opQueue.ts` were not modified anywhere in this branch (grepped, all present unchanged). pkm-tu5k's planned fix is fully compatible with the required-batch-id/required-deps contracts landed here; nothing in this branch narrows or reinterprets the gate.
- [x] Update sync/offline architecture documentation and run the full web verification gate — see Summary of Changes below

## Summary of Changes

- **Legacy queue and test-only transport deleted.** `createLegacyQueue`, `MAX_BATCH`, and `web/src/sync/opQueue.test.ts` are gone. Queue policy tests moved to `web/src/sync/opQueue.replica.test.ts`, driven by a new fake `web/src/sync/memReplica.ts`. `createOpQueue(replica: Replica, ...)` now takes a non-null `Replica`. `SyncProvider` builds an `absentReplica()` (every method throws `ReplicaUnavailableError`) only when the environment has no Worker — a jsdom-only path; production is unaffected.
- **Batch ids required end-to-end.** `Replica.enqueue(ops, batchId: string)` and `markPoisoned(id, error, batchId: string)` are non-optional both in the interface and the worker RPC payload (`web/src/replica/client.ts`, `web/src/replica/queue.ts`, `web/src/replica/workerHandlers.ts`). The unidentified-delivery FIFO bookkeeping is deleted; deliveries are keyed off the locally minted batch id instead.
- **Local API deps required.** `handleLocalApi(db, req, deps)` in `web/src/replica/localApi/router.ts` requires `deps`; the dead router re-export that permitted omitting it is deleted.
- **`runDrain` decomposed.** `web/src/sync/opQueue.ts` now names `deliverLaneHead`, `rejectDurableBatch`, `clearDurablePrecedence`, and `deferDurableQueue` (renamed from the side-effecting `laneOnly`). Comments no longer reference the deleted legacy queue.
- **pkm-tu5k reconciliation.** The poison-mark-intent localStorage mechanism, the start-in-recovering gate, and `retryPoisonMarks` were not touched anywhere in this branch — verified by grep. pkm-tu5k's planned fix remains fully compatible with the now-required batch-id/deps contracts.
- **Docs.** `docs/architecture/sync-and-offline.md`'s "Idempotent writes" row in the Key Pieces table now notes the server's 500-op-per-batch cap (`server/src/pkm/contracts/ops.py`), which the client no longer names anywhere since one enqueue is one durable row is one POST. `docs/architecture/frontend.md` needed no change: it never named `opQueue.test.ts` or described two queues. The peer branch's new derived-index parity paragraph in `sync-and-offline.md` § Offline editing and reconnect was left untouched.
