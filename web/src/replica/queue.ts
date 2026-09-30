// pattern: Imperative Shell
// The durable op queue (spec section 3): pending batches live INSIDE the
// replica database as wire-format JSON, so queued offline edits survive
// tab refresh and browser restart. update_text captures a current
// base_text_hash only when one is not already supplied; explicit
// snapshot hashes are preserved, and a user's own edit chain therefore
// flushes cleanly (op N leaves the text op N+1's hash matches). When it
// fills a hash it also fills a missing page_title, from the replica's own
// pages table, so the daily-note conflict header the server writes on a
// missing block can name the page. delete captures a base_subtree_hash of
// the block and its descendants the same way, only when none is supplied,
// so a delete after its child's delete in one batch hashes what that left.
// Poisoned batches (server terminal 4xx, see sync/rejection.ts) are set
// aside, never retried forever (spec section 6).

import type { BlockOp } from "../api/ops";
import type { PendingBatch, PoisonedBatch } from "./client";
import { type ReplicaDb, rollbackToSavepoint } from "./db";
import { applyLocalOps, LocalOpError } from "./localOps";
import { sha256Hex } from "./sha256";
import { subtreeHash } from "./subtreeHash";
import { findOpTitleViolation } from "./titles";

const currentText = (db: ReplicaDb, uid: string): string | null => {
  const rows = db.select<{ text: string }>(
    "SELECT text FROM blocks WHERE uid = ?", [uid]);
  return rows.length > 0 ? rows[0].text : null;
};

const currentPageTitle = (db: ReplicaDb, uid: string): string | null => {
  const rows = db.select<{ title: string }>(
    "SELECT p.title FROM blocks b JOIN pages p ON p.id = b.page_id" +
    " WHERE b.uid = ?", [uid]);
  return rows.length > 0 ? rows[0].title : null;
};

/** (uid, text) of `uid` and every descendant, or null when the replica has
 * no row for `uid`. Same visited-path guard as the server's subtree walk
 * (ops_apply._subtree_deepest_first): a proper tree never revisits a uid, so
 * the guard only ever ends the walk on already-corrupted parent links. */
const currentSubtreePairs = (db: ReplicaDb,
                             uid: string): [string, string][] | null => {
  const rows = db.select<{ uid: string; text: string }>(
    `WITH RECURSIVE sub(uid, text, path) AS (
       SELECT uid, text, ',' || uid || ',' FROM blocks WHERE uid = ?
       UNION ALL
       SELECT b.uid, b.text, s.path || b.uid || ','
         FROM sub s JOIN blocks b ON b.parent_uid = s.uid
        WHERE instr(s.path, ',' || b.uid || ',') = 0
     ) SELECT uid, text FROM sub`, [uid]);
  return rows.length > 0 ? rows.map((r) => [r.uid, r.text]) : null;
};

export function enqueueBatch(db: ReplicaDb, ops: BlockOp[], nowMs: number,
                             batchId: string): {
  pending: number;
  batchId: string;
} {
  const violation = findOpTitleViolation(ops);
  if (violation !== null) {
    throw new LocalOpError(
      `unsupported ${violation.source} title syntax: ${JSON.stringify(violation.title)}`,
      violation,
    );
  }
  if (ops.length > 0) {
    db.transaction(() => {
      const augmented: BlockOp[] = [];
      for (const op of ops) {
        let wireOp: BlockOp = op;
        if (op.op === "update_text" && op.base_text_hash === undefined) {
          // capture BEFORE this op's own optimistic apply
          const base = currentText(db, op.uid);
          // block unknown locally -> no hash: server applies plain LWW
          if (base !== null) {
            // page_title rides only with a hash filled here; a caller-hashed
            // op is stored exactly as sent. A filled copy can differ from the
            // fallback-lane copy opQueue keeps of the same batch_id
            // when a reply is lost: the server's replay hash ignores both
            // fields, so the second delivery still replays.
            const title = op.page_title === undefined
              ? currentPageTitle(db, op.uid) : null;
            wireOp = {
              ...op,
              base_text_hash: sha256Hex(base),
              ...(title !== null ? { page_title: title } : {}),
            };
          }
        } else if (op.op === "delete" && op.base_subtree_hash === undefined) {
          // capture BEFORE this op's own optimistic apply; a block unknown
          // locally goes out hashless and the server deletes it unguarded
          const pairs = currentSubtreePairs(db, op.uid);
          if (pairs !== null) {
            wireOp = { ...op, base_subtree_hash: subtreeHash(pairs) };
          }
        }
        augmented.push(wireOp);
        // Optimistic apply is a best-effort CACHE update; persistence must
        // never depend on it. During the bootstrap window ops legitimately
        // reference blocks the replica has not hydrated yet — skip the
        // local effect (savepoint) and keep the op on the wire; the feed's
        // reapplyPending restores local consistency once rows exist.
        db.exec("SAVEPOINT optimistic_op");
        try {
          applyLocalOps(db, [wireOp], nowMs);
          db.exec("RELEASE optimistic_op");
        } catch (error: unknown) {
          rollbackToSavepoint(db, "optimistic_op", error);
          db.exec("RELEASE optimistic_op");
        }
      }
      db.exec("INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, ?)",
              [batchId, JSON.stringify(augmented)]);
    });
  }
  return { pending: pendingCount(db), batchId };
}

const toBatch = (r: { id: number; batch_id: string; ops_json: string;
                      poisoned: number }): PendingBatch => ({
  id: r.id,
  batch_id: r.batch_id,
  ops: JSON.parse(r.ops_json) as BlockOp[],
  poisoned: r.poisoned !== 0,
});

export function nextBatch(db: ReplicaDb): PendingBatch | null {
  const rows = db.select<{ id: number; batch_id: string; ops_json: string;
                           poisoned: number }>(
    "SELECT id, batch_id, ops_json, poisoned FROM pending_ops" +
    " WHERE poisoned = 0 ORDER BY id LIMIT 1");
  return rows.length > 0 ? toBatch(rows[0]) : null;
}

/** All queued batches, oldest first, poisoned included — the recovery
 * flush wants the full picture. Reads only the migration-stable columns
 * (spec section 6 guardrail). */
export function allBatches(db: ReplicaDb): PendingBatch[] {
  return db.select<{ id: number; batch_id: string; ops_json: string;
                     poisoned: number }>(
    "SELECT id, batch_id, ops_json, poisoned FROM pending_ops ORDER BY id",
  ).map(toBatch);
}

const poisonDetails = (error: string | null): Pick<PoisonedBatch,
  "status" | "message"> => {
  if (error !== null) {
    try {
      const parsed = JSON.parse(error) as { status?: unknown; message?: unknown };
      if (typeof parsed.status === "number" && typeof parsed.message === "string") {
        return { status: parsed.status, message: parsed.message };
      }
    } catch { /* rows from older builds stored the display string directly */ }
  }
  const message = error ?? "rejected batch from a previous session";
  const match = message.match(/request failed:\s*(\d+)/);
  return { status: match ? Number(match[1]) : 400, message };
};

/** Rejected rows are queried separately from allBatches so Task 2's
 * schema-mismatch recovery read remains limited to migration-stable columns. */
export function poisonedBatches(db: ReplicaDb): PoisonedBatch[] {
  return db.select<{ id: number; batch_id: string; ops_json: string;
                     error: string | null }>(
    "SELECT id, batch_id, ops_json, error FROM pending_ops" +
    " WHERE poisoned != 0 ORDER BY id",
  ).map((row) => ({
    rowId: row.id,
    batchId: row.batch_id,
    ops: JSON.parse(row.ops_json) as BlockOp[],
    ...poisonDetails(row.error),
  }));
}

export function pendingCount(db: ReplicaDb): number {
  return Number(db.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_ops WHERE poisoned = 0")[0].n);
}

/** Delete one row, matched by id AND batch id; returns whether it matched.
 * A row id alone is not an identity: a reset or a file replacement restarts
 * the AUTOINCREMENT ids, so a delete that was queued for a batch the
 * rebuild dropped would otherwise remove the new batch that took its id. */
export function deleteBatch(db: ReplicaDb, id: number, batchId: string): boolean {
  const matches = db.select<{ id: number }>(
    "SELECT id FROM pending_ops WHERE id = ? AND batch_id = ?", [id, batchId]);
  if (matches.length === 0) return false;
  db.exec("DELETE FROM pending_ops WHERE id = ? AND batch_id = ?", [id, batchId]);
  return true;
}

export function markPoisoned(db: ReplicaDb, id: number, error: string,
                             batchId: string): boolean {
  const matches = db.select<{ id: number }>(
    "SELECT id FROM pending_ops WHERE id = ? AND batch_id = ?", [id, batchId]);
  if (matches.length === 0) return false;
  db.exec(
    "UPDATE pending_ops SET poisoned = 1, error = ? WHERE id = ? AND batch_id = ?",
    [error, id, batchId]);
  return true;
}

/** A pending_ops row exactly as stored, for moving the queue between files. */
export interface DurablePendingRow {
  id: number;
  batch_id: string;
  ops_json: string;
  poisoned: number;
  error: string | null;
}

/** Insert `rows` verbatim, ids included, in one transaction. Ids are kept
 * because the provider deletes a poisoned row by id after a repair and acked
 * seqs key on ids; a row whose id is already present is left as it is, so
 * importing the same rows twice is a no-op. */
export function importPendingRows(
  db: ReplicaDb, rows: readonly DurablePendingRow[],
): void {
  db.transaction(() => {
    for (const row of rows) {
      db.exec(
        "INSERT OR IGNORE INTO pending_ops(id, batch_id, ops_json, poisoned, error)" +
        " VALUES (?, ?, ?, ?, ?)",
        [row.id, row.batch_id, row.ops_json, row.poisoned, row.error]);
    }
  });
}
