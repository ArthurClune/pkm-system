---
# pkm-iskx
title: Web BatchId / ClientId brands
status: completed
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T13:30:19Z
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
- [x] `pnpm verify` clean


## Decision (2026-10-01)

The gen-types spike (pkm-85x3) has landed: use the x-brand route. Server NewTypes `BatchId` and `ClientId` (contracts/ops.py), each tagged with `brand()`, on `OpBatch.batch_id` / `client_id` and any WsBatch model; web brands in `web/src/api/brands.ts`. No hand narrowing in api/ops.ts.

## Summary of Changes

`BatchId` and `ClientId` go through the x-brand pipeline.

- **Server.** Both are NewTypes in `contracts/ops.py`, tagged with `brand()`,
  on `OpBatch.client_id` / `batch_id`, keeping the length constraints. Mint
  points: `client/api.py` `CLIENT_ID` and `client/workflows.py` `_batch_id`.
  The regen added 2 `x-brand` markers.
- **Web.** Both are defined in `api/brands.ts` and minted at:
  - `sync/opQueue.ts`: `clientId` and the batch ids, through `newUid`;
  - `replica/workerHandlers.ts`: `newBatchId`, through `crypto.randomUUID`;
  - the `replica/queue.ts` row mappers;
  - the worker RPC boundary, where they are re-asserted.

  `sync/socket.ts` `WsBatch.client_id` is narrowed by hand, because the WS
  frame sits outside OpenAPI. `PendingBatch`, `AckedBatch`, `PoisonedBatch`,
  `deleteBatch`, `markPoisoned`, `enqueue` and the outbox all carry
  `BatchId`.
- **Probes.** `@ts-expect-error` probes in `replica/client.test.ts` cover an
  `OpBatch` with `client_id` and `batch_id` swapped, and `markPoisoned` given
  the error string where the batch id belongs. Test fixtures cast literals to
  the brands, the same way the `PendingRowId` and `SyncSeq` tests do.
- **Checks.** pytest: 2263 passed. pyrefly: 0 errors, unchanged from main.
  ruff and tsc are clean. `pnpm verify` is green, including 72 e2e tests.
  `perf/check.sh` backend: no changes. Frontend: W/warm `first_outline_ms`
  was flagged as unstable (206 → 582 ms) while another worktree's suites were
  running. The harness reads that as flakiness, not this change, and
  pkm-c1hj is filed against it.
