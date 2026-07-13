// pattern: Imperative Shell
// Main-thread facade over the replica worker. All methods are thin typed
// RPC wrappers; the worker owns the database.

import type { BlockOp } from "../api/ops";
import type { ApplyResult, Changes, Snapshot } from "./apply";
import type { LocalApiRequest, LocalApiResult } from "./localApi/router";
import { createRpcClient, type PortLike } from "./rpc";

export interface PendingBatch {
  id: number;
  batch_id: string;
  ops: BlockOp[];
  poisoned: boolean;
}

export interface ReplicaInit {
  /** false => no-replica mode: wasm/OPFS unavailable, app runs online-only */
  ok: boolean;
  /** true => never bootstrapped; fetch a snapshot before serving reads */
  empty: boolean;
  cursor: number;
  /** stored schema_version differs from this build's: recovery required
   * (flush pendingBatches first — spec section 6) */
  schemaMismatch: boolean;
  /** read BEFORE any teardown, per the epic guardrail */
  pendingBatches: PendingBatch[];
}

export type { LocalApiRequest, LocalApiResult } from "./localApi/router";

export interface Replica {
  init(): Promise<ReplicaInit>;
  applySnapshot(snap: Snapshot): Promise<void>;
  applyChanges(feed: Changes): Promise<ApplyResult>;
  /** su05: persist + optimistically apply; returns pending count. */
  enqueue(ops: BlockOp[]): Promise<{ pending: number }>;
  nextBatch(): Promise<PendingBatch | null>;
  /** All queued batches, oldest first (recovery flush reads). */
  pendingBatches(): Promise<PendingBatch[]>;
  deleteBatch(id: number): Promise<{ pending: number }>;
  markPoisoned(id: number, error: string): Promise<{ pending: number }>;
  pendingCount(): Promise<number>;
  /** Offline API shim: handled:false = route not shimmed (online-only). */
  localApi(req: LocalApiRequest): Promise<LocalApiResult>;
  /** Drop and reinstall the schema. Caller enforces the non-empty-queue
   * guard (spec section 6): never call with unsynced pending ops. */
  reset(): Promise<void>;
}

export function createReplica(port: PortLike): Replica {
  const rpc = createRpcClient(port);
  return {
    init: () => rpc.call("init"),
    applySnapshot: (snap) => rpc.call("applySnapshot", snap),
    applyChanges: (feed) => rpc.call("applyChanges", feed),
    enqueue: (ops) => rpc.call("enqueue", ops),
    nextBatch: () => rpc.call("nextBatch"),
    pendingBatches: () => rpc.call("pendingBatches"),
    deleteBatch: (id) => rpc.call("deleteBatch", id),
    markPoisoned: (id, error) => rpc.call("markPoisoned", { id, error }),
    pendingCount: () => rpc.call("pendingCount"),
    localApi: (req) => rpc.call("localApi", req),
    reset: () => rpc.call("reset"),
  };
}
