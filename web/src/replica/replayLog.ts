// pattern: Imperative Shell
// The replay log: the pre-image of every row a pending batch's local apply
// writes, recorded before the write, so a feed window can rewind the batch's
// effects (rewind.ts), apply the server's rows, and replay the batch as a
// first apply. One record per (batch, row): the first touch wins, since that
// is the row as it stood before the batch.
//
// A block pre-image holds every blocks column but uid and page_id; the page
// goes in pre_page_id and the block's refs rows in replay_log_refs, because
// both carry page ids that remapLogPage must reach when a local page is
// reconciled. block_refs and FTS derive from the restored text and are never
// stored. A page pre-image holds updated_at, or is NULL for a page the batch
// minted. A block record with a NULL pre-image is a row the batch created.
//
// Every function runs inside the caller's transaction and opens none.

import type { BatchId, BlockUid, OrderIdx, PageId } from "../api/brands";
import type { ReplicaDb } from "./db";

export type BlockPreImage = {
  parent_uid: BlockUid | null;
  order_idx: OrderIdx;
  text: string;
  heading: number | null;
  collapsed: number;
  created_at: number | null;
  updated_at: number | null;
  view_type: "numbered" | "document" | null;
};

export type PagePreImage = { updated_at: number | null };

/** A batch is pending while any of its rows is still in pending_ops (a
 * poisoned batch included). */
export const PENDING_BATCH = "batch_id IN (SELECT batch_id FROM pending_ops)";

const BLOCK_PRE_JSON =
  "json_object('parent_uid', b.parent_uid, 'order_idx', b.order_idx," +
  " 'text', b.text, 'heading', b.heading, 'collapsed', b.collapsed," +
  " 'created_at', b.created_at, 'updated_at', b.updated_at," +
  " 'view_type', b.view_type)";

/** The refs rows of the records the caller just inserted: a record that
 * already existed keeps the refs of its first touch. */
const recordRefs = (db: ReplicaDb, inserted: { id: number }[]): void => {
  if (inserted.length === 0) return;
  db.exec(
    `INSERT INTO replay_log_refs(log_id, target_page_id, kind)
       SELECT l.id, r.target_page_id, r.kind
         FROM replay_log l JOIN refs r ON r.src_block_uid = l.key
        WHERE l.id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(inserted.map((r) => r.id))]);
};

/** Call before any write to these blocks: the row as it stands, or a NULL
 * pre-image for a uid with no row (the batch is creating it). */
export function recordBlocks(db: ReplicaDb, batchId: BatchId,
                             uids: readonly BlockUid[]): void {
  if (uids.length === 0) return;
  recordRefs(db, db.select<{ id: number }>(
    `INSERT OR IGNORE INTO replay_log(batch_id, kind, key, pre_json, pre_page_id)
       SELECT ?, 'block', j.value,
              CASE WHEN b.uid IS NULL THEN NULL ELSE ${BLOCK_PRE_JSON} END,
              b.page_id
         FROM json_each(?) j LEFT JOIN blocks b ON b.uid = j.value
      RETURNING id`,
    [batchId, JSON.stringify(uids)]));
}

/** Call before the sibling shift's UPDATE: records every row it will move. */
export function recordSiblingsFrom(
  db: ReplicaDb, batchId: BatchId,
  group: { pageId: PageId; parentUid: BlockUid | null; fromOrderIdx: OrderIdx },
): void {
  recordRefs(db, db.select<{ id: number }>(
    `INSERT OR IGNORE INTO replay_log(batch_id, kind, key, pre_json, pre_page_id)
       SELECT ?, 'block', b.uid, ${BLOCK_PRE_JSON}, b.page_id
         FROM blocks b
        WHERE b.page_id = ? AND b.parent_uid IS ? AND b.order_idx >= ?
      RETURNING id`,
    [batchId, group.pageId, group.parentUid, group.fromOrderIdx]));
}

/** Call before a page write; `minted` when the batch is creating the page. */
export function recordPage(db: ReplicaDb, batchId: BatchId, pageId: PageId,
                           minted: boolean): void {
  db.exec(
    `INSERT OR IGNORE INTO replay_log(batch_id, kind, key, pre_json)
     VALUES (?, 'page', ?,
             CASE WHEN ? THEN NULL
                  ELSE (SELECT json_object('updated_at', updated_at)
                          FROM pages WHERE id = ?) END)`,
    [batchId, String(pageId), minted ? 1 : 0, pageId]);
}

/** The batch's first local apply time, which its replays reuse. */
export function recordEnqueue(db: ReplicaDb, batchId: BatchId,
                              enqueuedMs: number): void {
  db.exec("INSERT OR IGNORE INTO replay_batches(batch_id, enqueued_ms) VALUES (?, ?)",
          [batchId, enqueuedMs]);
}

export function enqueuedAt(db: ReplicaDb, batchId: BatchId): number | null {
  const rows = db.select<{ enqueued_ms: number }>(
    "SELECT enqueued_ms FROM replay_batches WHERE batch_id = ?", [batchId]);
  return rows.length > 0 ? rows[0].enqueued_ms : null;
}

/** Drops the records on rows a window ships or owes a tombstone for: the
 * server's row is now the base. Only an acked batch's records go; a pending
 * batch is always rewound whole. */
export function dropWindowRecords(
  db: ReplicaDb,
  { uids, pageIds }: { uids: readonly BlockUid[]; pageIds: readonly PageId[] },
): void {
  if (uids.length === 0 && pageIds.length === 0) return;
  if (db.select("SELECT 1 FROM replay_log LIMIT 1").length === 0) return;
  db.exec(
    `DELETE FROM replay_log
      WHERE NOT ${PENDING_BATCH}
        AND ((kind = 'block' AND key IN (SELECT value FROM json_each(?)))
          OR (kind = 'page' AND key IN (SELECT value FROM json_each(?))))`,
    [JSON.stringify(uids), JSON.stringify(pageIds.map(String))]);
}

export function clearReplayLog(db: ReplicaDb): void {
  db.exec("DELETE FROM replay_log_refs");
  db.exec("DELETE FROM replay_log");
}

export function pruneReplayBatches(db: ReplicaDb): void {
  db.exec(`DELETE FROM replay_batches WHERE NOT ${PENDING_BATCH}`);
}

/** A local (negative) page id was reconciled to the server's page. A record
 * of a batch minting it goes, since the page is the server's now; a present
 * pre-image moves to the target's key, unless the batch already has a record
 * on the target, which wins. */
export function remapLogPage(
  db: ReplicaDb,
  { localId, targetId }: { localId: PageId; targetId: PageId },
): void {
  db.exec("UPDATE replay_log SET pre_page_id = ? WHERE pre_page_id = ?",
          [targetId, localId]);
  db.exec("UPDATE replay_log_refs SET target_page_id = ? WHERE target_page_id = ?",
          [targetId, localId]);
  const local = String(localId);
  db.exec("DELETE FROM replay_log WHERE kind = 'page' AND key = ? AND pre_json IS NULL",
          [local]);
  db.exec("UPDATE OR IGNORE replay_log SET key = ? WHERE kind = 'page' AND key = ?",
          [String(targetId), local]);
  db.exec("DELETE FROM replay_log WHERE kind = 'page' AND key = ?", [local]);
}
