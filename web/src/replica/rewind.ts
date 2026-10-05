// pattern: Imperative Shell
// The rewind: puts every row the replay log has a record on back to its
// pre-image, so the replica holds no pending effects while a window applies
// the server's rows. Per (kind, key) the record with the lowest id wins: the
// oldest batch's first touch, the row before any batch in scope wrote it.
//
// Rows are restored with UPDATE and INSERT, never REPLACE: with
// recursive_triggers on, REPLACE's implicit delete fires the FTS delete
// trigger and cascades the row's children and refs away.
//
// Order: (1) present rows with a pre-image are updated in place; (2) absent
// ones are inserted in rounds, each placing only rows whose parent (or, at
// the top level, page) is present, so parents land first and a row whose
// parent never appears is not placed; (3) rows the batches created are
// deleted, deepest first, after (1) has moved any restored child out from
// under them; (4) a page a batch minted is deleted when it is local and
// nothing holds it, and any other page record restores updated_at; (5) a
// rewound block whose parent or page is absent is dropped, since a record
// can outlive the place it names (a tombstone took it) and a dangling row
// would fail the window's deferred FK check at COMMIT. The records in scope
// are deleted last.
//
// Runs inside the caller's transaction, with FKs deferred, and opens none.

import type { BlockUid, CanonicalTitle, PageId } from "../api/brands";
import { reindexBlockRefs } from "./blockRefs";
import type { ReplicaDb } from "./db";
import { PENDING_BATCH } from "./replayLog";

/** `pending`: records of batches still in pending_ops, poisoned included;
 * `all`: every record, acked batches' too. */
export type LogScope = "pending" | "all";

/** The minted pages a rewind deleted, so a replay that mints the same title
 * can reuse the id. */
export type FreedPages = ReadonlyMap<CanonicalTitle, PageId>;

type BlockRecord = {
  id: number; key: BlockUid; has_pre: number; present: number;
  text_changed: number; pre_text: string | null;
};

const ids = (records: readonly BlockRecord[]): string =>
  JSON.stringify(records.map((r) => r.id));

/** The uids of present rows, deepest first. */
const deepestFirst = (db: ReplicaDb, uids: readonly BlockUid[]): BlockUid[] =>
  db.select<{ uid: BlockUid }>(
    `WITH RECURSIVE up(uid, at, path, depth) AS (
       SELECT uid, parent_uid, ',' || uid || ',', 0 FROM blocks
        WHERE uid IN (SELECT value FROM json_each(?))
       UNION ALL
       SELECT up.uid, p.parent_uid, up.path || p.uid || ',', up.depth + 1
         FROM up JOIN blocks p ON p.uid = up.at
        WHERE instr(up.path, ',' || p.uid || ',') = 0
     )
     SELECT uid FROM up GROUP BY uid ORDER BY MAX(depth) DESC, uid`,
    [JSON.stringify(uids)]).map((r) => r.uid);

const deleteBlocks = (db: ReplicaDb, uids: readonly BlockUid[]): void => {
  if (uids.length === 0) return;
  for (const uid of deepestFirst(db, uids)) {
    db.exec("DELETE FROM blocks WHERE uid = ?", [uid]);
  }
};

/** Replace the refs rows of these restored records' blocks with the
 * recorded ones, skipping pages that no longer exist. */
const restoreRefs = (db: ReplicaDb, logIds: string): void => {
  db.exec(
    `DELETE FROM refs WHERE src_block_uid IN
       (SELECT key FROM replay_log WHERE id IN (SELECT value FROM json_each(?)))`,
    [logIds]);
  db.exec(
    `INSERT OR IGNORE INTO refs(src_block_uid, target_page_id, kind)
       SELECT l.key, r.target_page_id, r.kind
         FROM replay_log_refs r JOIN replay_log l ON l.id = r.log_id
        WHERE r.log_id IN (SELECT value FROM json_each(?))
          AND EXISTS (SELECT 1 FROM pages WHERE id = r.target_page_id)`,
    [logIds]);
};

const BLOCK_COLUMNS =
  "uid, page_id, parent_uid, order_idx, text, heading, collapsed," +
  " created_at, updated_at, view_type";

export function rewind(db: ReplicaDb, scope: LogScope): Map<CanonicalTitle, PageId> {
  const freed = new Map<CanonicalTitle, PageId>();
  const inScope = scope === "pending" ? PENDING_BATCH : "1";
  if (db.select(`SELECT 1 FROM replay_log WHERE ${inScope} LIMIT 1`).length === 0) {
    return freed;
  }
  // A bare column beside MIN() takes its value from the row MIN() picked.
  const winners = (kind: "block" | "page") =>
    `SELECT id, key, pre_json, pre_page_id, MIN(id) FROM replay_log
      WHERE ${inScope} AND kind = '${kind}' GROUP BY key`;

  const blocks = db.select<BlockRecord>(
    `SELECT w.id, w.key, w.pre_json IS NOT NULL AS has_pre,
            b.uid IS NOT NULL AS present,
            b.text IS NOT (w.pre_json ->> 'text') AS text_changed,
            w.pre_json ->> 'text' AS pre_text
       FROM (${winners("block")}) w LEFT JOIN blocks b ON b.uid = w.key`);
  const restored = blocks.filter((r) => r.has_pre && r.present);
  const absent = blocks.filter((r) => r.has_pre && !r.present);
  const created = blocks.filter((r) => !r.has_pre && r.present);

  // 1. present rows back to their pre-image
  if (restored.length > 0) {
    db.exec(
      `UPDATE blocks SET
         page_id = l.pre_page_id,
         parent_uid = l.pre_json ->> 'parent_uid',
         order_idx = l.pre_json ->> 'order_idx',
         text = l.pre_json ->> 'text',
         heading = l.pre_json ->> 'heading',
         collapsed = l.pre_json ->> 'collapsed',
         created_at = l.pre_json ->> 'created_at',
         updated_at = l.pre_json ->> 'updated_at',
         view_type = l.pre_json ->> 'view_type'
       FROM replay_log l
      WHERE l.id IN (SELECT value FROM json_each(?)) AND blocks.uid = l.key`,
      [ids(restored)]);
    restoreRefs(db, ids(restored));
    for (const r of restored) {
      if (r.text_changed) reindexBlockRefs(db, r.key, r.pre_text!);
    }
  }

  // 2. absent rows inserted, parents first
  if (absent.length > 0) {
    const logId = new Map(absent.map((r) => [r.key, r.id]));
    const placed: { id: number; uid: BlockUid; text: string }[] = [];
    for (;;) {
      const round = db.select<{ uid: BlockUid; text: string }>(
        `INSERT INTO blocks(${BLOCK_COLUMNS})
           SELECT l.key, COALESCE(p.page_id, l.pre_page_id),
                  l.pre_json ->> 'parent_uid', l.pre_json ->> 'order_idx',
                  l.pre_json ->> 'text', l.pre_json ->> 'heading',
                  l.pre_json ->> 'collapsed', l.pre_json ->> 'created_at',
                  l.pre_json ->> 'updated_at', l.pre_json ->> 'view_type'
             FROM replay_log l
             LEFT JOIN blocks p ON p.uid = l.pre_json ->> 'parent_uid'
            WHERE l.id IN (SELECT value FROM json_each(?))
              AND NOT EXISTS (SELECT 1 FROM blocks x WHERE x.uid = l.key)
              AND CASE WHEN l.pre_json ->> 'parent_uid' IS NULL
                       THEN EXISTS (SELECT 1 FROM pages WHERE id = l.pre_page_id)
                       ELSE p.uid IS NOT NULL END
         RETURNING uid, text`,
        [ids(absent)]);
      if (round.length === 0) break;
      for (const row of round) placed.push({ id: logId.get(row.uid)!, ...row });
    }
    restoreRefs(db, JSON.stringify(placed.map((r) => r.id)));
    for (const row of placed) reindexBlockRefs(db, row.uid, row.text);
  }

  // 3. rows the batches created
  deleteBlocks(db, created.map((r) => r.key));

  // 4. pages
  db.exec(
    `UPDATE pages SET updated_at = w.pre_json ->> 'updated_at'
       FROM (${winners("page")}) w
      WHERE w.pre_json IS NOT NULL AND pages.id = CAST(w.key AS INTEGER)`);
  const minted = db.select<{ id: PageId; title: CanonicalTitle }>(
    `DELETE FROM pages
      WHERE id < 0
        AND id IN (SELECT CAST(key AS INTEGER) FROM (${winners("page")})
                    WHERE pre_json IS NULL)
        AND NOT EXISTS (SELECT 1 FROM blocks WHERE page_id = pages.id)
        AND NOT EXISTS (SELECT 1 FROM refs WHERE target_page_id = pages.id)
     RETURNING id, title`);
  for (const page of minted) freed.set(page.title, page.id);

  // 5. orphans: a rewound row whose parent or page is gone
  if (blocks.length > 0) {
    deleteBlocks(db, db.select<{ uid: BlockUid }>(
      `SELECT b.uid FROM blocks b
        WHERE b.uid IN (SELECT value FROM json_each(?))
          AND ((b.parent_uid IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM blocks p WHERE p.uid = b.parent_uid))
            OR NOT EXISTS (SELECT 1 FROM pages WHERE id = b.page_id))`,
      [JSON.stringify(blocks.map((r) => r.key))]).map((r) => r.uid));
  }

  db.exec(`DELETE FROM replay_log WHERE ${inScope}`);
  return freed;
}
