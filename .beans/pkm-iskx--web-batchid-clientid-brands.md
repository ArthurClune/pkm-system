---
# pkm-iskx
title: Web BatchId / ClientId brands
status: todo
type: task
priority: low
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T07:44:38Z
parent: pkm-7uxw
---

Brand `BatchId` and `ClientId` on the web. Both are bare `string`s minted by the same `newUid()` and placed next to each other in one request body: `{client_id: clientId, batch_id: batchId}` (`web/src/sync/opQueue.ts:135-137`).

- **`BatchId`**: the replay-dedup key shared by the `/api/ops` POST and the `pending_ops` row. It has three minters: `sync/opQueue.ts:640` `newUid()`, `replica/workerHandlers.ts:259` `crypto.randomUUID()` (local `POST /api/pages`), and `server/src/pkm/client/workflows.py:39` `uuid4().hex`. The server checks only length 8–64 (`contracts/ops.py:126`). Stored in `applied_batches.batch_id` (`schema.py:181`).
- **`ClientId`**: the per-tab sync identity (`sync/opQueue.ts:31`); also sent as `WsBatch.client_id` (`sync/socket.ts:26-27`).

There's a swap shape with every call site correct today: `markPoisoned(id, error: string, batchId: string)` (`replica/client.ts:115`, called at `sync/opQueue.ts:349-351`).

## Plan

- [ ] Brands minted at the two web minters
- [ ] Narrow `OpBatch` by hand in the `api/ops.ts` style, or use the generated brand once the gen-types spike has landed
- [ ] Optional: Py `BatchId`/`ClientId` NewTypes on `OpBatch`/`WsBatch` (needed if the spike's `x-brand` route is used)
- [ ] `pnpm verify` clean
