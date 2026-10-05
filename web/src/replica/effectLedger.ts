// pattern: Imperative Shell
// The effect ledger records what a pending batch's local apply did to rows
// the server will re-derive: order shifts on siblings and page moves. When
// the batch leaves the queue, the feed window's rebase replays the server's
// result on top of the replica. Where the server made the same write, its
// echo ships the row and drops the record. Where it did not (it placed a
// create or move in another group), the server never re-ships the rows the
// local apply disturbed, so settling a batch takes its collateral writes back.
//
// Invariants, with base the value a row's last resetting write (a window
// upsert, or a pending op's direct write) gave it: (1) order_idx = base
// order_idx + the sum of order_delta over the uid's records. (2) If a page
// record exists on a uid, every one carries the base page; otherwise page_id
// is the base's. So a row's page and updated_at revert only when no pending
// batch still holds a page record for it, and a later batch's move is never
// undone by an earlier batch settling.
//
// A row record (row_json set) means the block was removed by that batch's
// delete cascade. Its row_json is the base row and base_page_id the base
// page; it absorbs every other record on the uid, whose deltas and page
// record the base already has taken out.
//
// Every function runs inside the caller's transaction and opens none.

import type { BatchId, BlockUid, OrderIdx, PageId } from "../api/brands";
import type { ReplicaDb } from "./db";

const SETTLING = "batch_id NOT IN (SELECT batch_id FROM pending_ops)";

/** Call before the shift's UPDATE: adds +1 to the order delta of every row
 * the shift will move, except the block being placed. */
export function recordShift(
  db: ReplicaDb,
  batchId: BatchId,
  group: { pageId: PageId; parentUid: BlockUid | null; fromOrderIdx: OrderIdx },
  exceptUid: BlockUid,
): void {
  db.exec(
    `INSERT INTO effect_ledger(batch_id, uid, order_delta)
       SELECT ?, uid, 1 FROM blocks
        WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ? AND uid != ?
     ON CONFLICT(batch_id, uid) DO UPDATE SET order_delta = order_delta + 1`,
    [batchId, group.pageId, group.parentUid, group.fromOrderIdx, exceptUid]);
}

/** Call before the re-page UPDATE: the base is the one any record on this uid
 * already carries (they all share one), else the row's current page. */
export function recordRepage(db: ReplicaDb, batchId: BatchId, uid: BlockUid): void {
  db.exec(
    `INSERT INTO effect_ledger(batch_id, uid, order_delta, base_page_id, base_updated_at)
       SELECT ?, b.uid, 0,
              COALESCE(x.base_page_id, b.page_id),
              CASE WHEN x.base_page_id IS NOT NULL THEN x.base_updated_at
                   ELSE b.updated_at END
         FROM blocks b
         LEFT JOIN (SELECT base_page_id, base_updated_at FROM effect_ledger
                     WHERE uid = ? AND base_page_id IS NOT NULL LIMIT 1) x ON 1
        WHERE b.uid = ?
     ON CONFLICT(batch_id, uid) DO UPDATE SET
       base_page_id = COALESCE(base_page_id, excluded.base_page_id),
       base_updated_at = CASE WHEN base_page_id IS NULL
                              THEN excluded.base_updated_at
                              ELSE base_updated_at END`,
    [batchId, uid, uid]);
}

/** A row record's parsed row_json: the block's base row minus uid and page. */
export type CascadedRow = {
  parent_uid: BlockUid | null;
  order_idx: OrderIdx;
  text: string;
  heading: number | null;
  collapsed: number;
  created_at: number | null;
  updated_at: number | null;
  view_type: "numbered" | "document" | null;
};

/** Call before a cascade's DELETE of a descendant: replaces every record on
 * the uid with this batch's row record. */
export function recordCascade(db: ReplicaDb, batchId: BatchId, uid: BlockUid): void {
  const [row] = db.select<CascadedRow & { page_id: PageId }>(
    `SELECT b.parent_uid,
            b.order_idx - (SELECT COALESCE(SUM(order_delta), 0) FROM effect_ledger
                            WHERE uid = b.uid) AS order_idx,
            b.text, b.heading, b.collapsed, b.created_at,
            CASE WHEN x.base_page_id IS NOT NULL THEN x.base_updated_at
                 ELSE b.updated_at END AS updated_at,
            b.view_type,
            COALESCE(x.base_page_id, b.page_id) AS page_id
       FROM blocks b
       LEFT JOIN (SELECT base_page_id, base_updated_at FROM effect_ledger
                   WHERE uid = ? AND base_page_id IS NOT NULL AND row_json IS NULL
                   LIMIT 1) x ON 1
      WHERE b.uid = ?`,
    [uid, uid]);
  if (row === undefined) return;
  const base: CascadedRow = {
    parent_uid: row.parent_uid, order_idx: row.order_idx, text: row.text,
    heading: row.heading, collapsed: row.collapsed, created_at: row.created_at,
    updated_at: row.updated_at, view_type: row.view_type,
  };
  dropRecordsOf(db, uid);
  db.exec(
    `INSERT INTO effect_ledger(batch_id, uid, order_delta, base_page_id, row_json)
     VALUES (?, ?, 0, ?, ?)`,
    [batchId, uid, row.page_id, JSON.stringify(base)]);
}

export function dropRecordsOf(db: ReplicaDb, uid: BlockUid): void {
  db.exec("DELETE FROM effect_ledger WHERE uid = ?", [uid]);
}

export function dropWindowRecords(db: ReplicaDb, uids: readonly BlockUid[]): void {
  if (uids.length === 0) return;
  if (db.select("SELECT 1 FROM effect_ledger LIMIT 1").length === 0) return;
  db.exec(
    "DELETE FROM effect_ledger WHERE uid IN (SELECT value FROM json_each(?))",
    [JSON.stringify(uids)]);
}

/** Undo and delete the records of every batch no longer in pending_ops
 * (poisoned rows count as present). */
export function settleBatches(db: ReplicaDb): void {
  db.exec(
    `UPDATE blocks SET order_idx = order_idx - d.s
       FROM (SELECT uid, SUM(order_delta) AS s FROM effect_ledger
              WHERE ${SETTLING} GROUP BY uid) AS d
      WHERE blocks.uid = d.uid AND d.s != 0`);
  db.exec(
    `UPDATE blocks SET page_id = d.base_page_id, updated_at = d.base_updated_at
       FROM (SELECT uid, base_page_id, base_updated_at FROM effect_ledger e
              WHERE ${SETTLING} AND base_page_id IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM effect_ledger r
                                 WHERE r.uid = e.uid AND r.base_page_id IS NOT NULL
                                   AND r.batch_id IN (SELECT batch_id FROM pending_ops))
              GROUP BY uid) AS d
      WHERE blocks.uid = d.uid
        AND EXISTS (SELECT 1 FROM pages WHERE id = d.base_page_id)`);
  db.exec(`DELETE FROM effect_ledger WHERE ${SETTLING}`);
}

export function clearLedger(db: ReplicaDb): void {
  db.exec("DELETE FROM effect_ledger");
}

/** A local (negative) page id was reconciled to the server's page. */
export function remapBasePage(
  db: ReplicaDb,
  { localId, targetId }: { localId: PageId; targetId: PageId },
): void {
  db.exec("UPDATE effect_ledger SET base_page_id = ? WHERE base_page_id = ?",
    [targetId, localId]);
}
