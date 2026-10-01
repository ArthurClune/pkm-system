---
# pkm-ke5j
title: Typed method map for the replica worker RPC
status: in-progress
type: task
priority: low
created_at: 2026-10-01T16:45:35Z
updated_at: 2026-10-01T17:16:36Z
parent: pkm-7uxw
---

The replica worker's RPC is untyped at both ends.

- `web/src/replica/rpc.ts`: `RpcHandlers` is `Record<string, (payload: unknown) => Promise<unknown>>`, and `RpcClient.call<T>(method: string, payload?: unknown)`.
- So three mistakes fail only at runtime: a misspelled method name, a payload of the wrong shape, and a result read as the wrong type. The runtime error is `unknown replica method: …`.
- Each handler in `replica/workerHandlers.ts` starts with `payload as {...}`, and each wrapper in `replica/client.ts` picks its own `T`. Nothing ties the two sides together.
- Brands (`PendingRowId`, `SyncSeq`, `BatchId`, `ClientId`) cross the boundary only because both sides re-assert them by hand. `prepareRecovery` and `commitRecovery` cast to plain shapes.

pkm-he87 skipped this as optional. A method-name union alone would catch only typos; the real risk is the payload and result shapes.

## Proposal

One shared method map, for example `ReplicaRpc = { init: { payload: void; result: ReplicaInit }; deleteBatch: { payload: { id: PendingRowId; batchId: BatchId; ackedSeq?: SyncSeq }; result: { pending: number } }; ... }`. Then:

- `RpcClient.call<M extends keyof ReplicaRpc>(method: M, payload: ReplicaRpc[M]["payload"]): Promise<ReplicaRpc[M]["result"]>`;
- `RpcHandlers` becomes `{ [M in keyof ReplicaRpc]: (payload: ReplicaRpc[M]["payload"]) => Promise<ReplicaRpc[M]["result"]> }`;
- the remaining `payload as {...}` casts in `workerHandlers.ts` go away, apart from one documented boundary assertion where structured clone delivers `unknown`. Brands survive by type, not by hand.

The transport (`serveRpc` / `createRpcClient`) stays generic, while the replica's client and handlers bind to the map. Check whether anything else uses `rpc.ts` with another method set.

## Plan

- [x] Inventory every method: name, payload and result shape, from `client.ts` and `workerHandlers.ts`
- [x] Define the map, and type `call` and the handler record against it
- [x] Remove the per-handler payload casts, keeping one boundary assertion, and remove the per-wrapper `T` choices
- [x] `@ts-expect-error` probes: an unknown method name, a wrong payload shape, and a result read as the wrong type
- [ ] `pnpm verify` clean; perf unchanged (types only)
- [x] Docs: the sync-recovery.md or frontend.md note on the worker RPC
