// pattern: Imperative Shell
// The worker's RPC handler map, built over an injected database opener so
// the whole surface is testable without a real Worker or OPFS.

import type { BlockOp } from "../api/ops";
import type { Changes, Snapshot } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { PendingBatch } from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { getMeta } from "./meta";
import { handleLocalApi, type LocalApiRequest } from "./localApi/router";
import { allBatches, deleteBatch, enqueueBatch, markPoisoned, nextBatch,
         pendingCount } from "./queue";
import type { RpcHandlers } from "./rpc";

export interface WorkerDeps {
  openDb(): Promise<ReplicaDb>;
  /** Destroy the persistent database and return a fresh, empty one. */
  resetDb(): Promise<ReplicaDb>;
  /** Injectable for tests; the worker uses Date.now/crypto.randomUUID. */
  nowMs?: () => number;
  newBatchId?: () => string;
}

const tableExists = (db: ReplicaDb, name: string): boolean =>
  db.select("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?",
            [name]).length > 0;

function readPendingBatches(db: ReplicaDb): PendingBatch[] {
  // Guardrail (spec section 6): runs BEFORE any teardown decision, and
  // reads only the migration-stable columns so a newer client can always
  // extract wire-format JSON from an older database.
  if (!tableExists(db, "pending_ops")) return [];
  return allBatches(db);
}

export function buildHandlers(deps: WorkerDeps): RpcHandlers {
  let dbPromise: Promise<ReplicaDb> | null = null;
  const db = (): Promise<ReplicaDb> => (dbPromise ??= deps.openDb());
  const nowMs = deps.nowMs ?? (() => Date.now());
  const newBatchId = deps.newBatchId ?? (() => crypto.randomUUID());

  return {
    async enqueue(payload) {
      const d = await db();
      // the first edit can beat the socket connect that triggers init():
      // a fresh database gets its schema here so durability never waits.
      // An existing database (any version) is left alone — init() owns
      // schema-mismatch detection and recovery.
      if (!tableExists(d, "sync_client_meta")) installSchema(d);
      return enqueueBatch(d, payload as BlockOp[], nowMs(), newBatchId());
    },
    async nextBatch() {
      return nextBatch(await db());
    },
    async deleteBatch(payload) {
      return { pending: deleteBatch(await db(), payload as number) };
    },
    async markPoisoned(payload) {
      const { id, error } = payload as { id: number; error: string };
      return { pending: markPoisoned(await db(), id, error) };
    },
    async init() {
      let d: ReplicaDb;
      try {
        d = await db();
      } catch {
        // wasm/OPFS unavailable: the app degrades to online-only
        dbPromise = null;
        return { ok: false, empty: true, cursor: 0, schemaMismatch: false,
                 pendingBatches: [] };
      }
      const fresh = !tableExists(d, "sync_client_meta");
      const pendingBatches = fresh ? [] : readPendingBatches(d);
      if (fresh) installSchema(d);
      return {
        ok: true,
        empty: getMeta(d, "generation") === null,
        cursor: Number(getMeta(d, "cursor") ?? 0),
        schemaMismatch: getMeta(d, "schema_version") !== SCHEMA_VERSION,
        pendingBatches,
      };
    },
    async applySnapshot(payload) {
      applySnapshot(await db(), payload as Snapshot, nowMs());
      return null;
    },
    async applyChanges(payload) {
      return applyChanges(await db(), payload as Changes, nowMs());
    },
    async pendingBatches() {
      return readPendingBatches(await db());
    },
    async pendingCount() {
      return pendingCount(await db());
    },
    async localApi(payload) {
      return handleLocalApi(await db(), payload as LocalApiRequest,
                            { newBatchId });
    },
    async reset() {
      const d = await deps.resetDb();
      dbPromise = Promise.resolve(d);
      installSchema(d);
      return null;
    },
  };
}
