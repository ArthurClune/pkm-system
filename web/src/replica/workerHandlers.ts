// pattern: Imperative Shell
// The worker's RPC handler map, built over an injected database opener so
// the whole surface is testable without a real Worker or OPFS.

import type { BlockOp } from "../api/ops";
import type { Changes, Snapshot } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { PendingBatch, RecoveryCommit } from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { ReplicaUnavailableError } from "./errors";
import { getMeta } from "./meta";
import { handleLocalApi, type LocalApiRequest } from "./localApi/router";
import { allBatches, deleteBatch, enqueueBatch, markPoisoned, nextBatch,
         pendingCount, poisonedBatches } from "./queue";
import { createRecoveryGate } from "./recoveryGate";
import type { RpcHandlers } from "./rpc";

export interface WorkerDeps {
  openDb(): Promise<ReplicaDb>;
  /** Close the active database resource before the worker is terminated. */
  closeDb?(): Promise<void> | void;
  /** Injectable for tests; the worker uses Date.now/crypto.randomUUID. */
  nowMs?: () => number;
  clockMs?: () => number;
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

interface DurablePendingRow {
  id: number;
  batch_id: string;
  ops_json: string;
  poisoned: number;
  error: string | null;
}

function readDurablePendingRows(db: ReplicaDb): DurablePendingRow[] {
  if (!tableExists(db, "pending_ops")) return [];
  return db.select<DurablePendingRow>(
    "SELECT id, batch_id, ops_json, poisoned, error" +
    " FROM pending_ops ORDER BY id",
  );
}

const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

export function buildHandlers(deps: WorkerDeps): RpcHandlers {
  let dbPromise: Promise<ReplicaDb> | null = null;
  // The availability fact, owned here — the worker is the only party that can
  // say "there is definitively no database" rather than "I could not ask".
  //
  // This REPLACES pkm-bjae's latch, which worked by leaving the memoised
  // dbPromise rejection in place. That was correct but implicit: its safety
  // depended on a reader noticing that init() must not clear a promise three
  // modules from where the consequence lands (a barrier lift kicks a drain that
  // would have posted batches queued behind an undiscovered poison row). Two
  // independent reviewers read that mechanism identically and drew opposite
  // conclusions about whether it was a virtue or a defect. This says what it
  // means. close() is still the only reset.
  let unavailable: ReplicaUnavailableError | null = null;
  const db = async (): Promise<ReplicaDb> => {
    if (unavailable !== null) throw unavailable;
    dbPromise ??= deps.openDb();
    try {
      return await dbPromise;
    } catch (error: unknown) {
      // The original message is carried through verbatim: it is the only
      // diagnostic the banner has, and the op queue's storage-error whitelist
      // still matches on it until pkm-s7af replaces that with a type check.
      unavailable ??= new ReplicaUnavailableError(
        error instanceof Error ? error.message : String(error),
        { quota: (error as { quota?: boolean } | null)?.quota === true },
      );
      throw unavailable;
    }
  };
  const nowMs = deps.nowMs ?? (() => Date.now());
  const clockMs = deps.clockMs ?? (() => Date.now());
  const newBatchId = deps.newBatchId ?? (() => crypto.randomUUID());
  const applySnapshotToDb = deps.applySnapshot ?? applySnapshot;
  const gate = createRecoveryGate(
    deps.newRecoveryToken ?? (() => crypto.randomUUID()));
  let preparedRows: {
    token: string;
    fingerprint: string;
    expiryTimer: ReturnType<typeof setTimeout> | null;
  } | null = null;
  const fingerprint = (rows: readonly DurablePendingRow[]): string =>
    JSON.stringify(rows);
  const clearPrepared = (token: string): void => {
    if (preparedRows?.token !== token) return;
    if (preparedRows.expiryTimer !== null) {
      clearTimeout(preparedRows.expiryTimer);
    }
    preparedRows = null;
  };
  const rebuildSchema = (d: ReplicaDb, snapshot?: Snapshot): void => {
    // SQLite DDL is transactional. Keeping the active connection and doing the
    // logical rebuild in one transaction means schema or snapshot failure rolls
    // back to the complete old database, including poisoned durable rows.
    // Teardown order cannot be known for retired schemas. Disable FK actions
    // outside the transaction, then restore enforcement whether commit or
    // rollback wins; the transaction remains the atomic durability boundary.
    d.exec("PRAGMA foreign_keys=OFF");
    try {
      d.transaction(() => {
        for (const type of ["trigger", "view", "index"] as const) {
          const objects = d.select<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = ?" +
            " AND name NOT LIKE 'sqlite_%'" +
            (type === "index" ? " AND sql IS NOT NULL" : "") +
            " ORDER BY name",
            [type],
          );
          const keyword = type.toUpperCase();
          for (const object of objects) {
            d.exec(`DROP ${keyword} IF EXISTS ${quoteIdentifier(object.name)}`);
          }
        }
        // Drop virtual roots first; SQLite removes their implementation-owned
        // shadow tables. Re-query afterward so only genuinely remaining user
        // tables are dropped directly.
        const virtualTables = d.select<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name NOT LIKE 'sqlite_%'" +
          " AND upper(sql) LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name",
        );
        for (const table of virtualTables) {
          d.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`);
        }
        const tables = d.select<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table'" +
          " AND name NOT LIKE 'sqlite_%' ORDER BY name",
        );
        for (const table of tables) {
          d.exec(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`);
        }
        installSchema(d);
        if (snapshot) applySnapshotToDb(d, snapshot, nowMs());
      });
    } finally {
      d.exec("PRAGMA foreign_keys=ON");
    }
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
        const { id, error, batchId } = payload as {
          id: number; error: string; batchId?: string;
        };
        const d = await db();
        const matched = markPoisoned(d, id, error, batchId);
        const result: { pending: number; matched?: boolean } = {
          pending: pendingCount(d),
        };
        // Older direct handler callers omitted batch identity. Preserve their
        // response shape while typed clients always receive match evidence.
        if (batchId !== undefined) result.matched = matched;
        return result;
      });
    },
    async init() {
      return gate.run(async () => {
        // No catch: an unopenable database is db()'s latched
        // ReplicaUnavailableError, exactly as it is for every other handler.
        // Consumers derive "no-replica" from that rejection (pkm-61zt).
        const d = await db();
        const fresh = !tableExists(d, "sync_client_meta");
        const pendingBatches = fresh ? [] : readPendingBatches(d);
        if (fresh) installSchema(d);
        return {
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
    async poisonedBatches() {
      return gate.run(async () => {
        const d = await db();
        return tableExists(d, "pending_ops") ? poisonedBatches(d) : [];
      });
    },
    async pendingCount() {
      return gate.run(async () => pendingCount(await db()));
    },
    async localApi(payload) {
      return gate.run(async () => handleLocalApi(
        await db(), payload as LocalApiRequest, { newBatchId }));
    },
    async prepareRecovery(payload) {
      const expiresAtMs = Number(
        (payload as { expiresAtMs?: unknown } | undefined)?.expiresAtMs,
      );
      const hasDeadline = Number.isFinite(expiresAtMs);
      const prepared = await gate.prepare(async () => {
        const batches = readPendingBatches(await db());
        const durableRows = readDurablePendingRows(await db());
        if (hasDeadline && clockMs() >= expiresAtMs) {
          throw new Error("recovery preparation expired");
        }
        return { batches, fingerprint: fingerprint(durableRows) };
      });
      if (hasDeadline && clockMs() >= expiresAtMs) {
        await gate.abort(prepared.token);
        throw new Error("recovery preparation expired");
      }
      preparedRows = {
        token: prepared.token,
        fingerprint: prepared.value.fingerprint,
        expiryTimer: null,
      };
      if (hasDeadline) {
        preparedRows.expiryTimer = setTimeout(() => {
          void gate.abort(prepared.token)
            .catch(() => undefined)
            .finally(() => { clearPrepared(prepared.token); });
        }, Math.max(0, expiresAtMs - clockMs()));
      }
      return { token: prepared.token, batches: prepared.value.batches };
    },
    async commitRecovery(payload) {
      const { token, input } = payload as {
        token: string;
        input: RecoveryCommit;
      };
      if (preparedRows?.token === token
          && preparedRows.expiryTimer !== null) {
        clearTimeout(preparedRows.expiryTimer);
        preparedRows.expiryTimer = null;
      }
      try {
        await gate.commit(token, async () => {
          if (preparedRows?.token !== token) {
            throw new Error("invalid or inactive recovery token");
          }
          const current = readDurablePendingRows(await db());
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
        clearPrepared(token);
      }
    },
    async abortRecovery(payload) {
      const token = payload as string;
      if (preparedRows?.token === token
          && preparedRows.expiryTimer !== null) {
        clearTimeout(preparedRows.expiryTimer);
        preparedRows.expiryTimer = null;
      }
      await gate.abort(token);
      clearPrepared(token);
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
        // The only re-arm. A new open may now be attempted, and may succeed.
        dbPromise = null;
        unavailable = null;
        return null;
      });
    },
  };
}
