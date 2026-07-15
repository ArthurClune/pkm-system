// pattern: Imperative Shell
// The durable op queue (spec section 3): pending batches live INSIDE the
// replica database as wire-format JSON, so queued offline edits survive
// tab refresh and browser restart. Each update_text captures its
// base_text_hash from the replica's CURRENT text before the batch applies
// optimistically — a user's own edit chain therefore flushes cleanly (op
// N leaves the text op N+1's hash matches). Poisoned batches (server
// 4xx) are set aside, never retried forever (spec section 6).

import type { BlockOp, UpdateTextOp } from "../api/ops";
import type { PendingBatch, PoisonedBatch } from "./client";
import type { ReplicaDb } from "./db";
import { applyLocalOps } from "./localOps";
import { sha256Hex } from "./sha256";

const currentText = (db: ReplicaDb, uid: string): string | null => {
  const rows = db.select<{ text: string }>(
    "SELECT text FROM blocks WHERE uid = ?", [uid]);
  return rows.length > 0 ? rows[0].text : null;
};

export function enqueueBatch(db: ReplicaDb, ops: BlockOp[], nowMs: number,
                             batchId: string): { pending: number } {
  if (ops.length > 0) {
    db.transaction(() => {
      const augmented: BlockOp[] = [];
      for (const op of ops) {
        let wireOp: BlockOp = op;
        if (op.op === "update_text") {
          // capture BEFORE this op's own optimistic apply
          const base = currentText(db, op.uid);
          if (base !== null) {
            // block unknown locally -> no hash: server applies plain LWW
            wireOp = { ...op, base_text_hash: sha256Hex(base) } as UpdateTextOp;
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
        } catch {
          db.exec("ROLLBACK TO optimistic_op");
          db.exec("RELEASE optimistic_op");
        }
      }
      db.exec("INSERT INTO pending_ops(batch_id, ops_json) VALUES (?, ?)",
              [batchId, JSON.stringify(augmented)]);
    });
  }
  return { pending: pendingCount(db) };
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

export function deleteBatch(db: ReplicaDb, id: number): number {
  db.exec("DELETE FROM pending_ops WHERE id = ?", [id]);
  return pendingCount(db);
}

export function markPoisoned(db: ReplicaDb, id: number,
                             error: string): number {
  db.exec("UPDATE pending_ops SET poisoned = 1, error = ? WHERE id = ?",
          [error, id]);
  return pendingCount(db);
}
