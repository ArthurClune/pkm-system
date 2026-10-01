---
# pkm-he87
title: 'Web worker brands: SyncSeq and PendingRowId'
status: completed
type: task
priority: normal
created_at: 2026-10-01T07:44:38Z
updated_at: 2026-10-01T12:49:50Z
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

- [x] `SyncSeq` and `PendingRowId` brands; mint at the SQLite row mappers and `opsAck.ts`
- [x] One name for the row-id/batch-id pair across `PendingBatch`, `AckedBatch` and `PoisonedBatch`
- [x] Rename the local `seq` counters (lane seq, `resyncSeq`) so the name `SyncSeq` is unambiguous
- [x] Optional: a typed method map for the worker RPC (`ReplicaRpcMethod`). Today `call(method: string)` (`replica/rpc.ts:39,44-47,62-64`, handlers at `replica/workerHandlers.ts:413`) fails only at runtime, and brands survive structured clone only because both sides re-assert them (`prepareRecovery`/`commitRecovery` cast to plain shapes). -- evaluated and skipped, see summary
- [x] `pnpm verify` clean


## Decision (2026-10-01)

pkm-85x3 has landed. **SyncSeq goes through the x-brand pipeline**, not a hand alias in api/ops.ts: a server NewType `SyncSeq` in contracts, tagged with `brand()`, applied to the changes.seq wire fields (`ChangesPayload.next_since`/`latest_seq`, `SnapshotPayload.seq`, `OpsAck.seq`, and the WS notify seq if it has a pydantic model), with `SyncSeq` defined in `web/src/api/brands.ts`. PendingRowId stays web-only (replica SQLite, never on the wire).

## Summary of Changes

- **SyncSeq** goes through the x-brand pipeline. It is a server NewType in
  `contracts/responses.py`, tagged with `brand()`, on
  `ChangesPayload.next_since` / `latest_seq`, `SnapshotPayload.seq`,
  `OpsAck.seq`, `sync_core.Window` / `dedupe_window` and `notify.SeqFrame`.
  - Server mint points: every `MAX(seq)` read of the changes table, and the
    client's echoed `since` cursor.
  - Web: `SyncSeq` is defined in `api/brands.ts`. It is minted in `opsAck.ts`,
    in `workerHandlers.ts` `init()`, in `apply.ts` / `replicaSync.ts`, and in
    `sync/socket.ts`'s `WsSeq`, which is narrowed by hand because the WS frame
    sits outside OpenAPI.
  - The regen added 4 `x-brand` markers.
- **PendingRowId** is a web-only brand in `replica/client.ts`. It is minted at
  the row mappers in `replica/queue.ts`, and re-asserted at the worker RPC
  boundary, since structured clone carries the number but not the brand.
- **Naming.** `PoisonedBatch` moves from `rowId` / `batchId` to `id` /
  `batch_id`, matching `PendingBatch` and `AckedBatch`. That removes the
  translation code in `opQueue.ts` and `replicaSync.ts`.
- **Local counters renamed.** `outbox.ts` lane seq is now `laneSeq`, and
  `SyncProvider.tsx` `resyncSeq` is now `resyncGeneration` (also renamed in
  the docs and troubleshooting rows).
- **Probes.** `@ts-expect-error` swapped-argument probes cover
  `pendingSetStillCovered` and the `deleteBatch` / `AckedBatch` id and seq
  pair.
- **Typed RPC method map: skipped.** A method-name union would only catch a
  typo in a method name. The real risk is the payload and result shapes,
  which need a separate structural refactor of `rpc.ts`, `client.ts` and the
  handler map.
- **Checks.** pytest: 2263 passed. pyrefly: 0 errors, unchanged from main.
  ruff and tsc are clean. `pnpm verify` is green, including 72 e2e tests.
  `perf/check.sh`: backend unchanged. Frontend reported K/drag-* handler_ms
  "improvements" (55.9 → 24.2 ms and 16.5 → 6.5 ms) while another suite was
  running. A brand-only change can't explain that, so the rewritten baseline
  was discarded rather than committed.
