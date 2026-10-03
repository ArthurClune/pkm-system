// pattern: Imperative Shell
// The worker's RPC handler map, built over an injected database opener so
// the whole surface is testable without a real Worker or OPFS.

import type { BatchId, SyncSeq } from "../api/brands";
import type { Snapshot } from "./apply";
import { applyChanges, applySnapshot } from "./apply";
import { splitAckedRows } from "./ackedRows";
import { mergeCarriedRows } from "./carryMerge";
import type { CarryStore } from "./carryStore";
import type {
  AckedBatch, DroppedBatch, PendingBatch, PendingRowId, ReplicaDiagnostics,
  ReplicaRpc,
} from "./client";
import { SCHEMA_VERSION, installSchema } from "./clientSchema";
import type { ReplicaDb } from "./db";
import { isCorruptionMessage, isUnreadableFileMessage,
         ReplicaUnusableError } from "./errors";
import { getMeta } from "./meta";
import { handleLocalApi } from "./localApi/router";
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
   * the next openDb() creates an empty one. The escape from damage a logical
   * rebuild cannot get past, and from a file that cannot take a leftover
   * carry's rows. */
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
  newBatchId?: () => BatchId;
  newRecoveryToken?: () => string;
  /** Returns the pending rows the snapshot named as applied and deleted
   * (apply.ts applySnapshot); a stand-in that returns nothing dropped none. */
  applySnapshot?: (db: ReplicaDb, snapshot: Snapshot,
                   nowMs: number) => readonly DroppedBatch[] | void;
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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

export function buildHandlers(deps: WorkerDeps): RpcHandlers<ReplicaRpc> {
  let dbPromise: Promise<ReplicaDb> | null = null;
  // Whether the replica is usable, decided here — the worker is the only
  // party that can say "there is definitively no database" rather than "I
  // could not ask".
  //
  // Once set, `unusable` (and the memoised `dbPromise` rejection behind
  // it) must persist until close(): a barrier lift kicks a drain that would
  // post batches queued behind an undiscovered poison row, so nothing may
  // clear either before then. close() is the only reset.
  let unusable: ReplicaUnusableError | null = null;
  const db = async (): Promise<ReplicaDb> => {
    if (unusable !== null) throw unusable;
    dbPromise ??= deps.openDb();
    try {
      return await dbPromise;
    } catch (error: unknown) {
      // The original message is carried through verbatim: it is the only
      // diagnostic the banner has. Retention classifies by a type check on
      // this class, never by matching the message, so the message itself is
      // display-only from here on.
      unusable ??= new ReplicaUnusableError(
        error instanceof Error ? error.message : String(error),
      );
      throw unusable;
    }
  };
  /** The carried rows into `d`, with the same fresh-file rule init and
   * enqueue apply: a file with no schema gets one first. */
  const importCarried = (d: ReplicaDb, rows: readonly DurablePendingRow[]): void => {
    if (!tableExists(d, "sync_client_meta")) installSchema(d);
    importPendingRows(d, rows);
  };
  /** Import a carry left by a file replacement that did not finish, discard
   * it, and resolve to the database that now holds its rows.
   *
   * A carry is written only when its replica file has already been judged
   * damaged, and no handler can succeed while one exists (each adopts first
   * and fails if it cannot), so neither file's queue changes while it does.
   * A carry whose write committed holds every pending row the replica held
   * except those the rebase's acks settled, which the server already has;
   * one whose write failed or was cut short holds a subset, possibly none,
   * and the replica it was written from still holds them all. Beyond its
   * queue the replica is a cache the next snapshot refills. That makes two
   * escapes safe, and both are needed: rethrown, each would fail every
   * handler for good, the recovery that could clear it included.
   * - The carry cannot be read as a database at all. A carry write cut
   *   short is rolled back on the next open, to the carry's previous rows or
   *   to an empty file that reads as none, so this means storage damage (or
   *   a journal whose header never reached storage). The write comes before
   *   the replica is unlinked either way, so the replica still holds the
   *   rows, and the carry is discarded unread.
   * - The replica cannot take the rows (a new file torn while it was being
   *   built, or a transient I/O error): the carry's rows are merged with
   *   every row the old file can still be read for, written back to the
   *   carry, and only then is the old file replaced; the new file imports
   *   from that merged carry, so a short carry cannot shed rows only the old
   *   file held. An old file that cannot be read adds none; rows are lost
   *   then only if the carry is short too, which takes both files damaged.
   * Any other read failure (contention, transient I/O) propagates and keeps
   * the carry for the next handler, and so does a replacement that fails in
   * turn: the merged write lands before the old file goes, so the carry is
   * always the rows' sure copy from that point on. */
  const adoptLeftoverCarry = async (d: ReplicaDb): Promise<ReplicaDb> => {
    const carry = deps.carry;
    if (carry?.exists() !== true) return d;
    let rows: DurablePendingRow[];
    try {
      rows = carry.read();
    } catch (error: unknown) {
      if (!isUnreadableFileMessage(messageOf(error))) throw error;
      console.warn("replica: discarding an unreadable carry; the replica file"
                   + " written before it still holds its rows", error);
      carry.discard();
      return d;
    }
    let target = d;
    try {
      importCarried(target, rows);
    } catch (error: unknown) {
      if (!deps.discardDbFile) throw error;
      console.warn("replica: the replica file cannot take the carried rows,"
                   + " replacing it", error);
      const held = probe(() => readDurablePendingRows(target), () => []);
      const kept = mergeCarriedRows(rows, held);
      // committed to the carry before the old file goes, so a failure from
      // here on keeps the merged rows durable instead of only in memory
      carry.write(kept);
      // the new file's ids restart from the kept rows, as after a rebuild
      ackedSeqs.clear();
      await deps.discardDbFile();
      dbPromise = null;
      target = await db();
      importCarried(target, kept);
    }
    carry.discard();
    return target;
  };
  /** The database, for every handler that reads or writes the queue. A
   * carry that exists holds rows no replica file is known to hold, so it is
   * imported before any handler touches the queue: an insert first would
   * take the carried ids, and the by-id import would then drop those rows.
   * The recovery internals use db() instead, since mid-replacement the carry
   * is the rows' only copy and must not be adopted into a half-built file;
   * so does diagnostics, which only reads and must report on an unwell
   * database even when an adoption would fail. */
  const queueDb = async (): Promise<ReplicaDb> => adoptLeftoverCarry(await db());
  // Batch row id -> the journal seq its server ack named, for batches deleted
  // on an ack, or dropped because a sync payload named them as already
  // applied (the payload carries the stored ack's seq). applyChanges
  // consults it to accept a window fetched while such a batch was still
  // pending (see pendingGuard.ts). In memory only: a worker
  // restart starts a fresh pull with a fresh pending snapshot.
  const ackedSeqs = new Map<PendingRowId, SyncSeq>();
  /** Record the seq an ack named for a deleted row, or forget the row when
   * the ack named none. */
  const noteAck = (id: PendingRowId, seq: SyncSeq | null | undefined): void => {
    if (typeof seq === "number" && Number.isFinite(seq)) {
      ackedSeqs.set(id, seq);
    } else {
      ackedSeqs.delete(id);
    }
  };
  /** Record the acked seqs of the rows a payload's applied_batches dropped. */
  const noteDropped = (dropped: readonly DroppedBatch[] | void): void => {
    for (const row of dropped ?? []) noteAck(row.id, row.seq);
  };
  const nowMs = deps.nowMs ?? (() => Date.now());
  const clockMs = deps.clockMs ?? (() => Date.now());
  const newBatchId = deps.newBatchId ?? (() => crypto.randomUUID() as BatchId);
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
    if (!deps.discardDbFile || !isCorruptionMessage(messageOf(error))) throw error;
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
   * lost. The rows no ack covers move across verbatim, ids included, since
   * the provider deletes the poisoned row by id afterwards.
   *
   * The rows an ack in `acked` covers are deleted in the snapshot's own
   * transaction, before its replay, so the replica keeps the server's result
   * for them (a rename replay, a conflict, another device's write) instead of
   * their wire text. Only the rest are replayed and, on the replacement
   * path, carried. If the snapshot fails, the deletes roll back with it.
   *
   * The durable boundary: the rows are committed to the carry database
   * before the damaged file and its journal are unlinked. The new file
   * imports them from the carry by id once its schema is installed, and the
   * carry is discarded as soon as that import commits, so a later snapshot
   * failure leaves the rows in the new file and nothing stale behind to be
   * adopted again. From the unlink to that commit the carry is the only
   * copy, which is why every queue handler adopts a leftover carry before it
   * serves. */
  const rebaseOrReplaceFile = async (
    snapshot: Snapshot, rows: readonly DurablePendingRow[],
    acked: readonly AckedBatch[],
  ): Promise<void> => {
    const { settled, remaining } = splitAckedRows(rows, acked);
    try {
      const d = await db();
      const dropped = d.transaction(() => {
        for (const a of settled) deleteBatch(d, a.id, a.batch_id);
        return applySnapshotToDb(d, snapshot, nowMs());
      });
      for (const a of settled) noteAck(a.id, a.seq);
      noteDropped(dropped);
    } catch (error: unknown) {
      // No ack is recorded on this path: the rebuild clears ackedSeqs, and
      // the new file's ids restart from the highest carried one, so an acked
      // id above it may be reused by another batch.
      // No durable place for the rows: keep the damaged file, which still
      // holds them, rather than replace it.
      const carry = deps.carry;
      if (!carry) throw error;
      const fresh = await replaceFileAfter(error, () => {
        try {
          carry.write(remaining);
        } catch (writeError: unknown) {
          // The damaged file keeps the rows. A carry left behind would be
          // adopted as a short copy of them, so it goes now, best effort.
          try { carry.discard(); } catch { /* adoption copes with it */ }
          throw writeError;
        }
      });
      rebuildSchema(fresh);
      importPendingRows(fresh, carry.read());
      carry.discard();
      applySnapshotToDb(fresh, snapshot, nowMs());
    }
  };

  return {
    async enqueue({ ops, batchId }) {
      return gate.run(async () => {
        const d = await queueDb();
        // the first edit can beat the socket connect that triggers init():
        // a fresh database gets its schema here so durability never waits.
        // An existing database (any version) is left alone — init() owns
        // schema-mismatch detection and recovery.
        if (!tableExists(d, "sync_client_meta")) installSchema(d);
        return enqueueBatch(d, ops, nowMs(), batchId);
      });
    },
    async nextBatch() {
      return gate.run(async () => nextBatch(await queueDb()));
    },
    async deleteBatch({ id, batchId, ackedSeq }) {
      return gate.run(async () => {
        const d = await queueDb();
        // The payload is typed as requiring both fields, but a caller that
        // bypasses the typed Replica facade (a test, or a future one) can
        // still hand this a value that isn't really one: this is genuine
        // runtime defense, not the brand re-mint the type now does for free.
        if (typeof id !== "number" || typeof batchId !== "string") {
          throw new Error("deleteBatch needs the row's id and batch id");
        }
        // A delete that matched nothing cannot say which batch its seq was
        // for, so it records none and forgets any seq held for the id:
        // forgetting costs at most one refetch, vouching wrongly would let a
        // window apply over a batch it does not carry.
        const matched = deleteBatch(d, id, batchId);
        noteAck(id, matched ? ackedSeq : undefined);
        return { pending: pendingCount(d) };
      });
    },
    async markPoisoned({ id, error, batchId }) {
      return gate.run(async () => {
        const d = await queueDb();
        const matched = markPoisoned(d, id, error, batchId);
        return { pending: pendingCount(d), matched };
      });
    },
    async init() {
      return gate.run(async () => {
        // No catch: an unopenable database is db()'s latched
        // ReplicaUnusableError, exactly as it is for every other handler.
        // Consumers derive "no-replica" from that rejection.
        const d = await queueDb();
        const fresh = !tableExists(d, "sync_client_meta");
        const pendingBatches = fresh ? [] : readPendingBatches(d);
        if (fresh) installSchema(d);
        return {
          empty: getMeta(d, "generation") === null,
          cursor: Number(getMeta(d, "cursor") ?? 0) as SyncSeq,
          schemaMismatch: getMeta(d, "schema_version") !== SCHEMA_VERSION,
          pendingBatches,
        };
      });
    },
    async applySnapshot(snapshot) {
      return gate.run(async () => {
        noteDropped(applySnapshotToDb(await queueDb(), snapshot, nowMs()));
        return null;
      });
    },
    async applyChanges({ feed, expectedPendingIds }) {
      return gate.run(async () => {
        const d = await queueDb();
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
        // Only the rows this pull read when it named its pending batches to
        // the server may be dropped as already applied. The cover check above
        // already refuses a window when a row was queued since; passing the
        // ids keeps that rule from resting on it.
        const result = applyChanges(d, feed, nowMs(),
                                    { droppable: expectedPendingIds });
        if (result.status === "applied") noteDropped(result.dropped);
        return result;
      });
    },
    async pendingBatches() {
      return gate.run(async () => readPendingBatches(await queueDb()));
    },
    async poisonedBatches() {
      return gate.run(async () => {
        const d = await queueDb();
        return tableExists(d, "pending_ops") ? poisonedBatches(d) : [];
      });
    },
    async pendingCount() {
      return gate.run(async () => pendingCount(await queueDb()));
    },
    async localApi(req) {
      return gate.run(async () => handleLocalApi(
        await queueDb(), req, { newBatchId }));
    },
    async prepareRecovery(payload) {
      const expiresAtMs = Number(payload?.expiresAtMs);
      const hasDeadline = Number.isFinite(expiresAtMs);
      const prepared = await gate.prepare(async () => {
        const d = await queueDb();
        const batches = readPendingBatches(d);
        const durableRows = readDurablePendingRows(d);
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
    async commitRecovery({ token, input }) {
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
          const current = readDurablePendingRows(await queueDb());
          if (fingerprint(current) !== preparedRows.fingerprint) {
            throw new Error("pending rows changed during recovery");
          }
          if (input.kind === "reset") {
            await rebuildOrReplaceFile(input.snapshot);
          } else {
            await rebaseOrReplaceFile(input.snapshot, current, input.acked);
          }
        });
        return null;
      } finally {
        clearPrepared(token);
      }
    },
    async abortRecovery(token) {
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
        const current = readPendingBatches(await queueDb());
        if (current.length > 0) {
          throw new Error("cannot reset replica with pending rows");
        }
        await rebuildOrReplaceFile();
        return null;
      });
    },
    async diagnostics() {
      // db(), not queueDb(): see queueDb
      return gate.run(async () => collectDiagnostics(await db()));
    },
    async close() {
      return gate.run(async () => {
        await deps.closeDb?.();
        // The only re-arm. A new open may now be attempted, and may succeed.
        dbPromise = null;
        unusable = null;
        return null;
      });
    },
  };
}
