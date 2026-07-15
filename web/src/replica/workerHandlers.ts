// pattern: Imperative Shell
// The worker's RPC handler map, built over an injected database opener so
// the whole surface is testable without a real Worker or OPFS.

import type { BlockOp } from "../api/ops";
import type { Changes, Snapshot } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { PendingBatch, RecoveryCommit } from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { getMeta } from "./meta";
import { handleLocalApi, type LocalApiRequest } from "./localApi/router";
import { allBatches, deleteBatch, enqueueBatch, markPoisoned, nextBatch,
         pendingCount } from "./queue";
import { createRecoveryGate } from "./recoveryGate";
import type { RpcHandlers } from "./rpc";

export interface WorkerDeps {
  openDb(): Promise<ReplicaDb>;
  /** Close the active database resource before the worker is terminated. */
  closeDb?(): Promise<void> | void;
  /** Injectable for tests; the worker uses Date.now/crypto.randomUUID. */
  nowMs?: () => number;
  newBatchId?: () => string;
  newRecoveryToken?: () => string;
  applySnapshot?: (db: ReplicaDb, snapshot: Snapshot, nowMs: number) => void;
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
  const applySnapshotToDb = deps.applySnapshot ?? applySnapshot;
  const gate = createRecoveryGate(
    deps.newRecoveryToken ?? (() => crypto.randomUUID()));
  let preparedRows: { token: string; fingerprint: string } | null = null;
  const fingerprint = (batches: readonly PendingBatch[]): string =>
    JSON.stringify(batches);
  const rebuildSchema = (d: ReplicaDb, snapshot?: Snapshot): void => {
    // SQLite DDL is transactional. Keeping the active connection and doing the
    // logical rebuild in one transaction means schema or snapshot failure rolls
    // back to the complete old database, including poisoned durable rows.
    d.transaction(() => {
      d.exec("DROP TRIGGER IF EXISTS blocks_fts_ai");
      d.exec("DROP TRIGGER IF EXISTS blocks_fts_ad");
      d.exec("DROP TRIGGER IF EXISTS blocks_fts_au");
      d.exec("DROP TRIGGER IF EXISTS pages_fts_ai");
      d.exec("DROP TRIGGER IF EXISTS pages_fts_ad");
      d.exec("DROP TRIGGER IF EXISTS pages_fts_au");
      d.exec("DROP TABLE IF EXISTS blocks_fts");
      d.exec("DROP TABLE IF EXISTS pages_fts");
      d.exec("DROP TABLE IF EXISTS refs");
      d.exec("DROP TABLE IF EXISTS blocks");
      d.exec("DROP TABLE IF EXISTS pages");
      d.exec("DROP TABLE IF EXISTS sidebar_entries");
      d.exec("DROP TABLE IF EXISTS assets");
      d.exec("DROP TABLE IF EXISTS pending_ops");
      d.exec("DROP TABLE IF EXISTS sync_client_meta");
      installSchema(d);
      if (snapshot) applySnapshotToDb(d, snapshot, nowMs());
    });
  };

  return {
    async enqueue(payload) {
      return gate.run(async () => {
        const d = await db();
        // the first edit can beat the socket connect that triggers init():
        // a fresh database gets its schema here so durability never waits.
        // An existing database (any version) is left alone — init() owns
        // schema-mismatch detection and recovery.
        if (!tableExists(d, "sync_client_meta")) installSchema(d);
        return enqueueBatch(d, payload as BlockOp[], nowMs(), newBatchId());
      });
    },
    async nextBatch() {
      return gate.run(async () => nextBatch(await db()));
    },
    async deleteBatch(payload) {
      return gate.run(async () => ({
        pending: deleteBatch(await db(), payload as number),
      }));
    },
    async markPoisoned(payload) {
      return gate.run(async () => {
        const { id, error } = payload as { id: number; error: string };
        return { pending: markPoisoned(await db(), id, error) };
      });
    },
    async init() {
      return gate.run(async () => {
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
      });
    },
    async applySnapshot(payload) {
      return gate.run(async () => {
        applySnapshotToDb(await db(), payload as Snapshot, nowMs());
        return null;
      });
    },
    async applyChanges(payload) {
      return gate.run(async () => {
        const d = await db();
        const { feed, expectedPendingIds } = payload as {
          feed: Changes;
          expectedPendingIds: number[];
        };
        const currentPendingIds = allBatches(d).map((batch) => batch.id);
        if (currentPendingIds.length !== expectedPendingIds.length
            || currentPendingIds.some((id, index) => id !== expectedPendingIds[index])) {
          return { status: "pending-changed" };
        }
        return applyChanges(d, feed, nowMs());
      });
    },
    async pendingBatches() {
      return gate.run(async () => readPendingBatches(await db()));
    },
    async pendingCount() {
      return gate.run(async () => pendingCount(await db()));
    },
    async localApi(payload) {
      return gate.run(async () => handleLocalApi(
        await db(), payload as LocalApiRequest, { newBatchId }));
    },
    async prepareRecovery() {
      const prepared = await gate.prepare(async () => {
        const batches = readPendingBatches(await db());
        return { batches, fingerprint: fingerprint(batches) };
      });
      preparedRows = {
        token: prepared.token,
        fingerprint: prepared.value.fingerprint,
      };
      return { token: prepared.token, batches: prepared.value.batches };
    },
    async commitRecovery(payload) {
      const { token, input } = payload as {
        token: string;
        input: RecoveryCommit;
      };
      try {
        await gate.commit(token, async () => {
          if (preparedRows?.token !== token) {
            throw new Error("invalid or inactive recovery token");
          }
          const current = readPendingBatches(await db());
          if (fingerprint(current) !== preparedRows.fingerprint) {
            throw new Error("pending rows changed during recovery");
          }
          const d = await db();
          if (input.kind === "reset") {
            rebuildSchema(d, input.snapshot);
          } else {
            applySnapshotToDb(d, input.snapshot, nowMs());
          }
        });
        return null;
      } finally {
        if (preparedRows?.token === token) preparedRows = null;
      }
    },
    async abortRecovery(payload) {
      const token = payload as string;
      await gate.abort(token);
      if (preparedRows?.token === token) preparedRows = null;
      return null;
    },
    async reset() {
      return gate.run(async () => {
        const current = readPendingBatches(await db());
        if (current.length > 0) {
          throw new Error("cannot reset replica with pending rows");
        }
        rebuildSchema(await db());
        return null;
      });
    },
    async close() {
      return gate.run(async () => {
        await deps.closeDb?.();
        dbPromise = null;
        return null;
      });
    },
  };
}
