// pattern: Imperative Shell
// The worker's RPC handler map, built over an injected database opener so
// the whole surface is testable without a real Worker or OPFS.

import type { BlockOp } from "../api/ops";
import type { Changes, Snapshot } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import type { CarryStore } from "./carryStore";
import type { PendingBatch, RecoveryCommit, ReplicaDiagnostics } from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { isCorruptionMessage, ReplicaUnavailableError } from "./errors";
import { getMeta } from "./meta";
import { handleLocalApi, type LocalApiRequest } from "./localApi/router";
import { pendingSetStillCovered } from "./pendingGuard";
import { allBatches, deleteBatch, type DurablePendingRow, enqueueBatch,
         importPendingRows, markPoisoned, nextBatch, pendingCount,
         poisonedBatches } from "./queue";
import { createRecoveryGate } from "./recoveryGate";
import type { RpcHandlers } from "./rpc";

export interface WorkerDeps {
  openDb(): Promise<ReplicaDb>;
  /** Close the active database resource before the worker is terminated. */
  closeDb?(): Promise<void> | void;
  /** Close the database and delete its file (and any rollback journal), so
   * the next openDb() creates an empty one. The reset path's escape from
   * damage a logical rebuild cannot get past (pkm-h1c6). */
  discardDbFile?(): Promise<void> | void;
  /** Where a rebase commits the queue before a file replacement unlinks the
   * old file. Without one, a rebase never replaces the file. */
  carry?: CarryStore;
  /** Injectable for tests; the worker uses Date.now/crypto.randomUUID.
   * nowMs and clockMs both default to Date.now and are two names for the
   * same wall clock, kept distinct because they measure different things:
   * nowMs is the data-stamp clock (what gets written as updated_at/inserted
   * timestamps via applySnapshotToDb/enqueueBatch/applyChanges — see its
   * call sites below), clockMs is the deadline clock (what prepareRecovery
   * compares against the caller-supplied expiresAtMs). Tests inject them
   * independently so a fake data clock doesn't also have to fake recovery
   * deadlines, and vice versa. */
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

function readDurablePendingRows(db: ReplicaDb): DurablePendingRow[] {
  if (!tableExists(db, "pending_ops")) return [];
  return db.select<DurablePendingRow>(
    "SELECT id, batch_id, ops_json, poisoned, error" +
    " FROM pending_ops ORDER BY id",
  );
}

const quoteIdentifier = (name: string): string =>
  `"${name.replaceAll('"', '""')}"`;

/** Run one probe; its error text stands in for a result it could not give.
 * The report is read moments before a rebuild drops the tables, over a
 * database already known to be unwell, so no probe may sink the others. */
const probe = <T>(fn: () => T, fallback: (message: string) => T): T => {
  try {
    return fn();
  } catch (error: unknown) {
    return fallback(error instanceof Error ? error.message : String(error));
  }
};

const countRows = (db: ReplicaDb, table: string): number => probe(
  () => Number(db.select<{ n: number }>(
    `SELECT count(*) AS n FROM ${quoteIdentifier(table)}`)[0].n),
  () => -1);

/** FTS5's own consistency check. The second argument (1) makes it compare
 * the index against the external content table as well as checking the
 * index's own structure; without it an index that simply lacks a content
 * row passes, which is the very divergence being diagnosed. */
const ftsIntegrity = (db: ReplicaDb, table: string): string => probe(
  () => {
    db.exec(`INSERT INTO ${quoteIdentifier(table)}(${quoteIdentifier(table)}, rank)` +
            " VALUES ('integrity-check', 1)");
    return "ok";
  },
  (message) => message);

function collectDiagnostics(db: ReplicaDb): ReplicaDiagnostics {
  return {
    sqliteVersion: probe(
      () => db.select<{ v: string }>("SELECT sqlite_version() AS v")[0].v,
      (message) => message),
    quickCheck: probe(
      () => db.select<{ quick_check: string }>("PRAGMA quick_check(5)")
        .map((row) => row.quick_check),
      (message) => [message]),
    integrity: {
      blocks_fts: ftsIntegrity(db, "blocks_fts"),
      pages_fts: ftsIntegrity(db, "pages_fts"),
    },
    counts: {
      pages: countRows(db, "pages"),
      blocks: countRows(db, "blocks"),
      pending_ops: countRows(db, "pending_ops"),
      pages_fts_docsize: countRows(db, "pages_fts_docsize"),
      blocks_fts_docsize: countRows(db, "blocks_fts_docsize"),
    },
    meta: {
      cursor: probe(() => getMeta(db, "cursor"), () => null),
      generation: probe(() => getMeta(db, "generation"), () => null),
      schema_version: probe(() => getMeta(db, "schema_version"), () => null),
    },
  };
}

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
      // diagnostic the banner has. Retention no longer matches on it (pkm-s7af
      // made that a type check on this class instead), so the message itself
      // is display-only from here on.
      unavailable ??= new ReplicaUnavailableError(
        error instanceof Error ? error.message : String(error),
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
  // Batch row id -> the journal seq its server ack named, for batches deleted
  // on an ack. applyChanges consults it to accept a window fetched while such
  // a batch was still pending (see pendingGuard.ts). In memory only: a worker
  // restart starts a fresh pull with a fresh pending snapshot.
  const ackedSeqs = new Map<number, number>();
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
    // Dropping pending_ops also drops its AUTOINCREMENT counter, so row ids
    // may be reused after this: no recorded acked seq may outlive it.
    ackedSeqs.clear();
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
  /** rebuildSchema, falling back to a brand-new file. The logical rebuild
   * rewrites the same file, so page-level damage (a broken freelist or page
   * map, which quick_check reports and the FTS checks do not) fails its DROPs
   * with SQLITE_CORRUPT every time, and so does every later reset. Pending
   * rows lose nothing: a reset drops pending_ops either way, and its caller
   * already holds them from prepareRecovery. */
  const rebuildOrReplaceFile = async (snapshot?: Snapshot): Promise<void> => {
    try {
      rebuildSchema(await db(), snapshot);
    } catch (error: unknown) {
      rebuildSchema(await replaceFileAfter(error), snapshot);
    }
  };
  /** Delete the damaged file and open a fresh one, if `error` is corruption
   * and the host can delete files; otherwise rethrow `error`.
   * `beforeDiscard` runs once the file is known to be going and before
   * anything is deleted; if it throws, the file is kept. */
  const replaceFileAfter = async (
    error: unknown, beforeDiscard?: () => void,
  ): Promise<ReplicaDb> => {
    const message = error instanceof Error ? error.message : String(error);
    if (!deps.discardDbFile || !isCorruptionMessage(message)) throw error;
    beforeDiscard?.();
    console.warn("replica: rebuild hit file-level corruption, replacing the file",
                 error);
    await deps.discardDbFile();
    dbPromise = null;
    return db();
  };
  /** A rebase, and on the same file-level damage the same escape, except
   * that a rebase keeps the durable queue: the rejected-batch repair runs one
   * so the valid rows behind a poisoned batch are not posted ahead of it or
   * lost. `rows` move across verbatim, ids included, since the provider
   * deletes the poisoned row by id afterwards.
   *
   * The durable boundary: the rows are committed to the carry database
   * before the damaged file and its journal are unlinked. The new file
   * imports them from the carry by id once its schema is installed, and the
   * carry is discarded as soon as that import commits, so a later snapshot
   * failure leaves the rows in the new file and nothing stale behind to be
   * adopted again. From the unlink to that commit the carry is the only
   * copy, which is why every handler adopts a leftover carry before it
   * serves. */
  const rebaseOrReplaceFile = async (
    snapshot: Snapshot, rows: readonly DurablePendingRow[],
  ): Promise<void> => {
    try {
      applySnapshotToDb(await db(), snapshot, nowMs());
    } catch (error: unknown) {
      // No durable place for the rows: keep the damaged file, which still
      // holds them, rather than replace it.
      const carry = deps.carry;
      if (!carry) throw error;
      const fresh = await replaceFileAfter(error, () => { carry.write(rows); });
      rebuildSchema(fresh);
      importPendingRows(fresh, carry.read());
      carry.discard();
      applySnapshotToDb(fresh, snapshot, nowMs());
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
        // The object shape always carries the caller-minted batch id
        // (pkm-ybgt): worker and main bundle ship from one hashed build, so
        // no version skew between caller and handler is possible.
        const { ops, batchId } = payload as { ops: BlockOp[]; batchId: string };
        return enqueueBatch(d, ops, nowMs(), batchId);
      });
    },
    async nextBatch() {
      return gate.run(async () => nextBatch(await db()));
    },
    async deleteBatch(payload) {
      // A bare row id is accepted too: it is the pre-pkm-ur2n payload shape.
      const { id, ackedSeq } = typeof payload === "number"
        ? { id: payload, ackedSeq: undefined }
        : payload as { id: number; ackedSeq?: number };
      return gate.run(async () => {
        const pending = deleteBatch(await db(), id);
        if (typeof ackedSeq === "number" && Number.isFinite(ackedSeq)) {
          ackedSeqs.set(id, ackedSeq);
        } else {
          ackedSeqs.delete(id);
        }
        return { pending };
      });
    },
    async markPoisoned(payload) {
      return gate.run(async () => {
        const { id, error, batchId } = payload as {
          id: number; error: string; batchId: string;
        };
        const d = await db();
        const matched = markPoisoned(d, id, error, batchId);
        return { pending: pendingCount(d), matched };
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
        const covered = pendingSetStillCovered(
          expectedPendingIds, currentPendingIds, ackedSeqs, feed.latest_seq);
        // pullLoop is single-flight and snapshots the pending set afresh for
        // every window, so an acked seq for an id outside this snapshot can
        // never be consulted again: drop it here to keep the map bounded.
        const expected = new Set(expectedPendingIds);
        for (const id of ackedSeqs.keys()) {
          if (!expected.has(id)) ackedSeqs.delete(id);
        }
        if (!covered) return { status: "pending-changed" };
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
          if (input.kind === "reset") {
            await rebuildOrReplaceFile(input.snapshot);
          } else {
            await rebaseOrReplaceFile(input.snapshot, current);
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
        await rebuildOrReplaceFile();
        return null;
      });
    },
    async diagnostics() {
      return gate.run(async () => collectDiagnostics(await db()));
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
