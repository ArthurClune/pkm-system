// pattern: Imperative Shell
// Main-thread facade over the replica worker. All methods are thin typed
// RPC wrappers; the worker owns the database.

import type { BlockOp } from "../api/ops";
import type { ApplyResult, Changes, Snapshot } from "./apply";
import type { LocalApiRequest, LocalApiResult } from "./localApi/router";
import { createRpcClient, type PortLike } from "./rpc";

const RECOVERY_TIMEOUT_MS = 120_000;

export interface PendingBatch {
  id: number;
  batch_id: string;
  ops: BlockOp[];
  poisoned: boolean;
}

/** Durable rejected-row details used to resume authoritative repair after a
 * reload. The worker reconstructs these from pending_ops, including rows
 * written by the pre-typed poison implementation. */
export interface PoisonedBatch {
  rowId: number;
  batchId: string;
  ops: readonly BlockOp[];
  status: number;
  message: string;
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

export interface RecoveryLease {
  token: string;
  batches: readonly PendingBatch[];
}

export type RecoveryCommit =
  | { kind: "reset"; snapshot: Snapshot }
  | { kind: "rebase"; snapshot: Snapshot };

export type { LocalApiRequest, LocalApiResult } from "./localApi/router";

export interface Replica {
  init(): Promise<ReplicaInit>;
  applySnapshot(snap: Snapshot): Promise<void>;
  applyChanges(feed: Changes,
               expectedPendingIds?: readonly number[]): Promise<ApplyResult>;
  /** su05: persist + optimistically apply; returns pending count. */
  enqueue(ops: BlockOp[]): Promise<{ pending: number }>;
  nextBatch(): Promise<PendingBatch | null>;
  /** All queued batches, oldest first (recovery flush reads). */
  pendingBatches(): Promise<PendingBatch[]>;
  /** Rejected durable rows, oldest first, for startup repair. */
  poisonedBatches(): Promise<PoisonedBatch[]>;
  deleteBatch(id: number): Promise<{ pending: number }>;
  markPoisoned(id: number, error: string): Promise<{ pending: number }>;
  pendingCount(): Promise<number>;
  /** Offline API shim: handled:false = route not shimmed (online-only). */
  localApi(req: LocalApiRequest): Promise<LocalApiResult>;
  /** FIFO barrier: earlier database work finishes and later work waits. */
  prepareRecovery(): Promise<RecoveryLease>;
  /** Final durable-row comparison and authoritative rebuild/rebase. */
  commitRecovery(token: string, input: RecoveryCommit): Promise<void>;
  /** Release a prepared lease without destructive work. */
  abortRecovery(token: string): Promise<void>;
  /** Drop and reinstall the schema. Caller enforces the non-empty-queue
   * guard (spec section 6): never call with unsynced pending ops. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export function createReplica(port: PortLike, terminate?: () => void): Replica {
  const rpc = createRpcClient(port);
  let disposing: Promise<void> | null = null;
  return {
    init: () => rpc.call("init"),
    applySnapshot: (snap) => rpc.call("applySnapshot", snap, { timeoutMs: 120_000 }),
    applyChanges: (feed, expectedPendingIds = []) => rpc.call("applyChanges", {
      feed, expectedPendingIds,
    }),
    enqueue: (ops) => rpc.call("enqueue", ops),
    nextBatch: () => rpc.call("nextBatch"),
    pendingBatches: () => rpc.call("pendingBatches"),
    poisonedBatches: () => rpc.call("poisonedBatches"),
    deleteBatch: (id) => rpc.call("deleteBatch", id),
    markPoisoned: (id, error) => rpc.call("markPoisoned", { id, error }),
    pendingCount: () => rpc.call("pendingCount"),
    localApi: (req) => rpc.call("localApi", req),
    prepareRecovery: () => rpc.call(
      "prepareRecovery",
      { expiresAtMs: Date.now() + RECOVERY_TIMEOUT_MS },
      { timeoutMs: RECOVERY_TIMEOUT_MS }),
    commitRecovery: (token, input) => rpc.call(
      "commitRecovery", { token, input }, { timeoutMs: 120_000 }),
    abortRecovery: (token) => rpc.call("abortRecovery", token),
    reset: () => rpc.call("reset", undefined, { timeoutMs: 120_000 }),
    dispose: () => (disposing ??= (async () => {
      try {
        await rpc.call("close");
      } catch {
        // Worker failure/timeout still requires local teardown.
      } finally {
        rpc.dispose();
        terminate?.();
      }
    })()),
  };
}
