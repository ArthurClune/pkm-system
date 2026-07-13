// pattern: Imperative Shell
// The worker's RPC handler map, built over an injected database opener so
// the whole surface is testable without a real Worker or OPFS.

import type { Changes, Snapshot } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { PendingBatch } from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { getMeta } from "./meta";
import type { RpcHandlers } from "./rpc";

export interface WorkerDeps {
  openDb(): Promise<ReplicaDb>;
  /** Destroy the persistent database and return a fresh, empty one. */
  resetDb(): Promise<ReplicaDb>;
}

const tableExists = (db: ReplicaDb, name: string): boolean =>
  db.select("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?",
            [name]).length > 0;

export function readPendingBatches(db: ReplicaDb): PendingBatch[] {
  // Guardrail (spec section 6): runs BEFORE any teardown decision, and
  // reads only the migration-stable columns so a newer client can always
  // extract wire-format JSON from an older database.
  if (!tableExists(db, "pending_ops")) return [];
  return db.select<{ id: number; batch_id: string; ops_json: string; poisoned: number }>(
    "SELECT id, batch_id, ops_json, poisoned FROM pending_ops ORDER BY id",
  ).map((r) => ({
    id: r.id,
    batch_id: r.batch_id,
    ops: JSON.parse(r.ops_json) as PendingBatch["ops"],
    poisoned: r.poisoned !== 0,
  }));
}

export function buildHandlers(deps: WorkerDeps): RpcHandlers {
  let dbPromise: Promise<ReplicaDb> | null = null;
  const db = (): Promise<ReplicaDb> => (dbPromise ??= deps.openDb());

  return {
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
      applySnapshot(await db(), payload as Snapshot);
      return null;
    },
    async applyChanges(payload) {
      return applyChanges(await db(), payload as Changes);
    },
    async pendingBatches() {
      return readPendingBatches(await db());
    },
    async pendingCount() {
      const d = await db();
      return Number(d.select<{ n: number }>(
        "SELECT COUNT(*) AS n FROM pending_ops WHERE poisoned = 0")[0].n);
    },
    async reset() {
      const d = await deps.resetDb();
      dbPromise = Promise.resolve(d);
      installSchema(d);
      return null;
    },
  };
}
