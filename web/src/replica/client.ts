// pattern: Imperative Shell
// Main-thread facade over the replica worker. All methods are thin typed
// RPC wrappers; the worker owns the database.

import type { SyncSeq } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { ApplyResult, Changes, Snapshot } from "./apply";
import type { LocalApiRequest, LocalApiResult } from "./localApi/router";
import { createRpcClient, type PortLike } from "./rpc";

/** Timeout budget for every recovery-adjacent worker RPC (prepareRecovery,
 * applySnapshot, commitRecovery, reset): these can process a full local
 * database and share the same generous allowance. */
const RECOVERY_TIMEOUT_MS = 120_000;

/** A `pending_ops` row id (SQLite AUTOINCREMENT), web-only: it never
 * crosses the wire, and it is not stable across a reset or a file
 * replacement (AUTOINCREMENT restarts, see workerHandlers.ts
 * rebuildSchema). Distinct from `SyncSeq` so the two can never swap at a
 * call like `deleteBatch(id, batchId, ackedSeq)`. Minted only at the
 * SQLite row mappers in replica/queue.ts (toBatch, poisonedBatches) and at
 * the RPC boundary in replica/workerHandlers.ts, which re-asserts it on
 * every payload read out of `unknown` (structured clone carries the
 * runtime number, not the brand). */
export type PendingRowId = number & { readonly __brand: "PendingRowId" };

export interface PendingBatch {
  id: PendingRowId;
  batch_id: string;
  ops: BlockOp[];
  poisoned: boolean;
}

/** Durable rejected-row details used to resume authoritative repair after a
 * reload. The worker reconstructs these from pending_ops, including rows
 * written by the pre-typed poison implementation. Same `id`/`batch_id`
 * naming as PendingBatch and AckedBatch (not `rowId`/`batchId`): the three
 * name the same pending_ops row/batch pair, and rejectDurableBatch
 * (sync/opQueue.ts) builds one of these directly from a PendingBatch. */
export interface PoisonedBatch {
  id: PendingRowId;
  batch_id: string;
  ops: readonly BlockOp[];
  status: number;
  message: string;
}

export interface ReplicaInit {
  /** true => never bootstrapped; fetch a snapshot before serving reads */
  empty: boolean;
  cursor: SyncSeq;
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

/** A leased batch the server acknowledged during a recovery flush. `seq` is
 * the journal seq the ack named, or null for a stored ack that predates the
 * field. */
export interface AckedBatch {
  id: PendingRowId;
  batch_id: string;
  seq: SyncSeq | null;
}

/** A reset drops the queue, so it carries no acks. A rebase deletes the rows
 * its `acked` entries match (by id and batch id) before the snapshot's
 * replay, so the replica keeps what the server saved for them. */
export type RecoveryCommit =
  | { kind: "reset"; snapshot: Snapshot }
  | { kind: "rebase"; snapshot: Snapshot; acked: readonly AckedBatch[] };

/** What the replica can say about its own database, gathered before a
 * corruption rebuild drops the evidence. Every probe is
 * independent: a probe that throws contributes its error text, never a
 * rejection of the whole report. */
export interface ReplicaDiagnostics {
  sqliteVersion: string;
  /** `PRAGMA quick_check` rows (`["ok"]` when the b-trees are sound). */
  quickCheck: string[];
  /** FTS5 `integrity-check` per index: "ok" or the error it raised. */
  integrity: { blocks_fts: string; pages_fts: string };
  /** Content rows beside their FTS docsize shadow rows: a difference is the
   * index/content divergence FTS5 reports as SQLITE_CORRUPT_VTAB. */
  counts: { pages: number; blocks: number; pending_ops: number;
            pages_fts_docsize: number; blocks_fts_docsize: number };
  meta: { cursor: string | null; generation: string | null;
          schema_version: string | null };
}

export type { LocalApiRequest, LocalApiResult } from "./localApi/router";

export interface Replica {
  /** Rejects with ReplicaUnusableError when the database cannot be opened;
   * the worker has latched that for the session. */
  init(): Promise<ReplicaInit>;
  applySnapshot(snap: Snapshot): Promise<void>;
  applyChanges(feed: Changes,
               expectedPendingIds?: readonly PendingRowId[]): Promise<ApplyResult>;
  /** su05: persist + optimistically apply; returns pending count. The caller
   * ALWAYS mints batchId BEFORE this call: if the reply is lost after the row
   * was persisted, the copy the caller retains still shares the row's id, so
   * a duplicate delivery hits the server's replay dedup instead of a
   * create-collision 400. */
  enqueue(ops: BlockOp[],
          batchId: string): Promise<{ pending: number; batchId: string }>;
  nextBatch(): Promise<PendingBatch | null>;
  /** All queued batches, oldest first (recovery flush reads). */
  pendingBatches(): Promise<PendingBatch[]>;
  /** Rejected durable rows, oldest first, for startup repair. */
  poisonedBatches(): Promise<PoisonedBatch[]>;
  /** Deletes the row only when both `id` and `batchId` match it: a reset or
   * a file replacement restarts row ids, and a delete queued behind one must
   * not remove the new batch that took the id.
   * `ackedSeq` is the journal seq the server's ack named for this batch's
   * commit, when known: it lets a pull whose pending snapshot still held the
   * batch apply a window that already carries it. Deletes that are not an
   * ack (a rebase settle, a poison discard) omit it. A rebase commit deletes
   * the rows its flush got acks for itself, and records their seqs the same
   * way. */
  deleteBatch(id: PendingRowId, batchId: string,
              ackedSeq?: SyncSeq): Promise<{ pending: number }>;
  markPoisoned(id: PendingRowId, error: string, batchId: string): Promise<{
    pending: number; matched: boolean;
  }>;
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
  /** Read-only self-report for the corruption path; never rejects for a
   * broken index, only for a database that cannot be opened at all. */
  diagnostics(): Promise<ReplicaDiagnostics>;
  dispose(): Promise<void>;
}

export function createReplica(port: PortLike, terminate?: () => void): Replica {
  const rpc = createRpcClient(port);
  let disposing: Promise<void> | null = null;
  return {
    init: () => rpc.call("init"),
    applySnapshot: (snap) =>
      rpc.call("applySnapshot", snap, { timeoutMs: RECOVERY_TIMEOUT_MS }),
    applyChanges: (feed, expectedPendingIds = []) => rpc.call("applyChanges", {
      feed, expectedPendingIds,
    }),
    enqueue: (ops, batchId) => rpc.call("enqueue", { ops, batchId }),
    nextBatch: () => rpc.call("nextBatch"),
    pendingBatches: () => rpc.call("pendingBatches"),
    poisonedBatches: () => rpc.call("poisonedBatches"),
    deleteBatch: (id, batchId, ackedSeq) =>
      rpc.call("deleteBatch", { id, batchId, ackedSeq }),
    markPoisoned: (id, error, batchId) =>
      rpc.call("markPoisoned", { id, error, batchId }),
    pendingCount: () => rpc.call("pendingCount"),
    localApi: (req) => rpc.call("localApi", req),
    prepareRecovery: () => rpc.call(
      "prepareRecovery",
      { expiresAtMs: Date.now() + RECOVERY_TIMEOUT_MS },
      { timeoutMs: RECOVERY_TIMEOUT_MS }),
    commitRecovery: (token, input) => rpc.call(
      "commitRecovery", { token, input }, { timeoutMs: RECOVERY_TIMEOUT_MS }),
    abortRecovery: (token) => rpc.call("abortRecovery", token),
    reset: () => rpc.call("reset", undefined, { timeoutMs: RECOVERY_TIMEOUT_MS }),
    diagnostics: () =>
      rpc.call("diagnostics", undefined, { timeoutMs: RECOVERY_TIMEOUT_MS }),
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
