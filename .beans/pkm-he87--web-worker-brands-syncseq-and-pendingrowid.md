---
# pkm-he87
title: 'Web worker brands: SyncSeq and PendingRowId'
status: in-progress
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T12:07:17Z
parent: pkm-7uxw
---

Brand the worker-side numeric ids in `web/src/replica/` and the sync layer. Neither goes through OpenAPI as a brand, so this needs no gen-types work.

- **`SyncSeq`**: the server's `changes.seq`, the sync cursor. Narrowed on the web at `sync/opsAck.ts:22-28` and in the meta cursor accessor (`replica/apply.ts:89,348`, `replica/workerHandlers.ts:472`). Crosses HTTP (`ChangesPayload.next_since/latest_seq`, `SnapshotPayload.seq`, `OpsAck.seq`) and WS (`sync/socket.ts:36-41`). On those wire fields, narrow by hand in the `api/ops.ts` style for now.
- **`PendingRowId`**: the replica's `pending_ops` AUTOINCREMENT (`replica/queue.ts:19-25`, mapped at `:119-125`), not stable across a reset.

## Evidence

- These calls mix the two as bare `number`s: `noteAck(id, seq)` (`replica/workerHandlers.ts:250`), `pendingSetStillCovered(expected, current, ackedSeqs, latestSeq)` (`replica/pendingGuard.ts:25-41`).
- `OpsAck.ts` (epoch ms) sits next to `OpsAck.seq` (`server/src/pkm/contracts/responses.py:477,486`).
- The same row-id/batch-id pair is named `id`/`batch_id` in `PendingBatch`/`AckedBatch` but `rowId`/`batchId` in `PoisonedBatch` (`replica/client.ts:15-20` vs `:25-31`), which forces manual translation in `opQueue.ts` and `replicaSync.ts`.
- Local counters named `seq` are a different thing and must not get `SyncSeq`: the lane seq at `sync/outbox.ts:14-18,26`, and `resyncSeq` at `sync/SyncProvider.tsx:107,133`.

## Plan

- [ ] `SyncSeq` and `PendingRowId` brands; mint at the SQLite row mappers and `opsAck.ts`
- [ ] One name for the row-id/batch-id pair across `PendingBatch`, `AckedBatch` and `PoisonedBatch`
- [ ] Rename the local `seq` counters (lane seq, `resyncSeq`) so the name `SyncSeq` is unambiguous
- [ ] Optional: a typed method map for the worker RPC (`ReplicaRpcMethod`). Today `call(method: string)` (`replica/rpc.ts:39,44-47,62-64`, handlers at `replica/workerHandlers.ts:413`) fails only at runtime, and brands survive structured clone only because both sides re-assert them (`prepareRecovery`/`commitRecovery` cast to plain shapes).
- [ ] `pnpm verify` clean


## Decision (2026-10-01)

pkm-85x3 has landed. **SyncSeq goes through the x-brand pipeline**, not a hand alias in api/ops.ts: a server NewType `SyncSeq` in contracts, tagged with `brand()`, applied to the changes.seq wire fields (`ChangesPayload.next_since`/`latest_seq`, `SnapshotPayload.seq`, `OpsAck.seq`, and the WS notify seq if it has a pydantic model), with `SyncSeq` defined in `web/src/api/brands.ts`. PendingRowId stays web-only (replica SQLite, never on the wire).
