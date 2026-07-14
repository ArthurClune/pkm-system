// pattern: Imperative Shell
// Optimistic application of the editor's own ops to the replica (spec
// section 3): while offline the user's edits must render locally,
// including in backlinks and search, before the server ever sees them.
// This mirrors the server's ops_core/ops_apply semantics minus conflict
// handling — a local apply is always clean (the server resolves conflicts
// at push time). Pages referenced or created locally get temporary
// NEGATIVE ids, reconciled when the feed delivers the authoritative row
// (reconcile.ts); ops carry titles, so negative ids never go on the wire.

import type { BlockOp } from "../api/ops";
import type { ReplicaDb } from "./db";
import { extractRefs } from "./refs";

export class LocalOpError extends Error {}

export function getOrCreateLocalPage(db: ReplicaDb, title: string,
                                     nowMs: number): number {
  const existing = db.select<{ id: number }>(
    "SELECT id FROM pages WHERE title = ?", [title]);
  if (existing.length > 0) return existing[0].id;
  const next = db.select<{ id: number }>(
    "SELECT MIN(0, COALESCE((SELECT MIN(id) FROM pages), 0)) - 1 AS id")[0].id;
  db.exec(
    "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
    [next, title, nowMs, nowMs]);
  return next;
}

const reindexRefs = (db: ReplicaDb, uid: string, text: string,
                     nowMs: number): void => {
  db.exec("DELETE FROM refs WHERE src_block_uid = ?", [uid]);
  for (const ref of extractRefs(text).refs) {
    const pageId = getOrCreateLocalPage(db, ref.title, nowMs);
    db.exec("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
            [uid, pageId, ref.kind]);
  }
};

const touchPage = (db: ReplicaDb, pageId: number, nowMs: number): void => {
  db.exec("UPDATE pages SET updated_at = ? WHERE id = ?", [nowMs, pageId]);
};

const shiftSiblings = (db: ReplicaDb, pageId: number,
                       parentUid: string | null, fromIdx: number): void => {
  db.exec(
    "UPDATE blocks SET order_idx = order_idx + 1" +
    " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ?",
    [pageId, parentUid, fromIdx]);
};

interface BlockInfo { page_id: number; parent_uid: string | null }

const blockInfo = (db: ReplicaDb, uid: string): BlockInfo | null => {
  const rows = db.select<BlockInfo>(
    "SELECT page_id, parent_uid FROM blocks WHERE uid = ?", [uid]);
  return rows.length > 0 ? rows[0] : null;
};

const requireBlock = (db: ReplicaDb, uid: string): BlockInfo => {
  const info = blockInfo(db, uid);
  if (info === null) throw new LocalOpError(`block not found: ${uid}`);
  return info;
};

const subtreeUids = (db: ReplicaDb, uid: string): string[] =>
  db.select<{ uid: string }>(
    `WITH RECURSIVE sub(uid, depth) AS (
       SELECT uid, 0 FROM blocks WHERE uid = ?
       UNION ALL
       SELECT b.uid, s.depth + 1 FROM sub s
         JOIN blocks b ON b.parent_uid = s.uid
        WHERE s.depth < 100
     ) SELECT uid FROM sub ORDER BY depth DESC`, [uid]).map((r) => r.uid);

function applyOne(db: ReplicaDb, op: BlockOp, nowMs: number): void {
  switch (op.op) {
    case "create_page": {
      getOrCreateLocalPage(db, op.page_title, nowMs);
      return;
    }
    case "create": {
      const pageId = getOrCreateLocalPage(db, op.page_title, nowMs);
      shiftSiblings(db, pageId, op.parent_uid ?? null, op.order_idx);
      db.exec(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
        " heading, collapsed, created_at, updated_at, view_type)" +
        " VALUES (?,?,?,?,?,?,0,?,?,?)",
        [op.uid, pageId, op.parent_uid ?? null, op.order_idx, op.text,
         op.heading ?? null, nowMs, nowMs, op.view_type ?? null]);
      reindexRefs(db, op.uid, op.text, nowMs);
      touchPage(db, pageId, nowMs);
      return;
    }
    case "update_text": {
      const info = requireBlock(db, op.uid);
      db.exec("UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
              [op.text, nowMs, op.uid]);
      reindexRefs(db, op.uid, op.text, nowMs);
      touchPage(db, info.page_id, nowMs);
      return;
    }
    case "move": {
      const info = requireBlock(db, op.uid);
      const parent = op.parent_uid ? requireBlock(db, op.parent_uid) : null;
      const targetPage = parent !== null
        ? parent.page_id
        : (op.page_title != null
           ? getOrCreateLocalPage(db, op.page_title, nowMs)
           : info.page_id);
      shiftSiblings(db, targetPage, op.parent_uid ?? null, op.order_idx);
      db.exec(
        "UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = ?" +
        " WHERE uid = ?",
        [op.parent_uid ?? null, op.order_idx, nowMs, op.uid]);
      if (targetPage !== info.page_id) {
        for (const uid of subtreeUids(db, op.uid)) {
          db.exec("UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
                  [targetPage, nowMs, uid]);
        }
        touchPage(db, info.page_id, nowMs);
      }
      touchPage(db, targetPage, nowMs);
      return;
    }
    case "delete": {
      const info = requireBlock(db, op.uid);
      for (const uid of subtreeUids(db, op.uid)) {
        db.exec("DELETE FROM blocks WHERE uid = ?", [uid]);
      }
      touchPage(db, info.page_id, nowMs);
      return;
    }
    case "set_collapsed": {
      const info = requireBlock(db, op.uid);
      db.exec("UPDATE blocks SET collapsed = ?, updated_at = ? WHERE uid = ?",
              [op.collapsed ? 1 : 0, nowMs, op.uid]);
      touchPage(db, info.page_id, nowMs);
      return;
    }
    case "set_heading": {
      const info = requireBlock(db, op.uid);
      db.exec("UPDATE blocks SET heading = ?, updated_at = ? WHERE uid = ?",
              [op.heading ?? null, nowMs, op.uid]);
      touchPage(db, info.page_id, nowMs);
      return;
    }
    case "set_view_type": {
      const info = requireBlock(db, op.uid);
      db.exec("UPDATE blocks SET view_type = ?, updated_at = ? WHERE uid = ?",
              [op.view_type, nowMs, op.uid]);
      touchPage(db, info.page_id, nowMs);
      return;
    }
  }
}

/** Apply a batch atomically; a throwing op rolls the whole batch back.
 * Failures are expected while the replica is behind the editor (ops can
 * reference rows the sync feed has not delivered yet) — callers treat the
 * local apply as best-effort cache maintenance, never as durability. */
export function applyLocalOps(db: ReplicaDb, ops: BlockOp[],
                              nowMs: number): void {
  db.transaction(() => {
    for (const op of ops) applyOne(db, op, nowMs);
  });
}
