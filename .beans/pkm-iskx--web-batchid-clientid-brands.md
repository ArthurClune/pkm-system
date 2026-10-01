---
# pkm-iskx
title: Web BatchId / ClientId brands
status: in-progress
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T12:51:54Z
parent: pkm-7uxw
---

Brand `BatchId` and `ClientId` on the web. Both are bare `string`s minted by the same `newUid()` and placed next to each other in one request body: `{client_id: clientId, batch_id: batchId}` (`web/src/sync/opQueue.ts:135-137`).

- **`BatchId`**: the replay-dedup key shared by the `/api/ops` POST and the `pending_ops` row. It has three minters: `sync/opQueue.ts:640` `newUid()`, `replica/workerHandlers.ts:259` `crypto.randomUUID()` (local `POST /api/pages`), and `server/src/pkm/client/workflows.py:39` `uuid4().hex`. The server checks only length 8–64 (`contracts/ops.py:126`). Stored in `applied_batches.batch_id` (`schema.py:181`).
- **`ClientId`**: the per-tab sync identity (`sync/opQueue.ts:31`); also sent as `WsBatch.client_id` (`sync/socket.ts:26-27`).

There's a swap shape with every call site correct today: `markPoisoned(id, error: string, batchId: string)` (`replica/client.ts:115`, called at `sync/opQueue.ts:349-351`).

## Plan

- [x] Server `BatchId`/`ClientId` NewTypes (`contracts/ops.py`), each `brand()`ed, on `OpBatch.client_id`/`batch_id`; mint points typed at `client/api.py` `CLIENT_ID` and `client/workflows.py` `_batch_id`
- [x] Regenerated `openapi.json`/`types.d.ts`; web brands defined in `web/src/api/brands.ts`
- [x] Brands minted at the two web minters (`sync/opQueue.ts` `clientId`/`batchId`, `replica/workerHandlers.ts` `newBatchId`) and threaded through `outbox.ts`, `replica/client.ts`, `replica/queue.ts`, `replica/workerHandlers.ts`, `replica/localApi/router.ts`, `sync/socket.ts` (`WsBatch.client_id`, hand-narrowed), `sync/replicaSync.ts`, `sync/memReplica.ts`
- [x] `@ts-expect-error` probes: OpBatch client_id/batch_id swap and markPoisoned's error/batchId swap (`replica/client.test.ts`)
- [ ] `pnpm verify` clean


## Decision (2026-10-01)

The gen-types spike (pkm-85x3) has landed: use the x-brand route. Server NewTypes `BatchId` and `ClientId` (contracts/ops.py), each tagged with `brand()`, on `OpBatch.batch_id` / `client_id` and any WsBatch model; web brands in `web/src/api/brands.ts`. No hand narrowing in api/ops.ts.
