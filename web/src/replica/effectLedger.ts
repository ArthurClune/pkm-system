// pattern: Imperative Shell
// The effect ledger records what a pending batch's local apply did to rows
// the server will re-derive: order shifts on siblings and page moves. When
// the batch leaves the queue, the feed window's rebase replays the server's
// result on top of the replica, so any local effect of a settled batch must
// be taken back first or it is counted twice.
//
// Invariants: (1) a record exists only while its effect is in the replica
// and not yet in the feed; settling a batch undoes exactly its records and
// deletes them. (2) A row's page and updated_at revert to the base only when
// no pending batch still holds a page record for it, so a later batch's move
// is never undone by an earlier batch settling.
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
