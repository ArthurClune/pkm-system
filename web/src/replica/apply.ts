// pattern: Imperative Shell
// Feed application (spec sections 3 and 1): snapshot bootstrap and windowed
// changes upserts. Each window applies in ONE transaction, ordered pages ->
// blocks -> refs -> tombstones, under transaction-scoped deferred FKs so
// intra-window row order never matters. Upserts are idempotent -- re-pulling
// any window is safe. The base schema's FTS triggers maintain the local
// search index on every upsert.

import type { components } from "../api/types";
import type { ReplicaDb, SqlValue } from "./db";
import { applyLocalOps } from "./localOps";
import { getMeta, setMeta } from "./meta";
import { allBatches } from "./queue";
import { reconcilePage } from "./reconcile";

export type Changes = components["schemas"]["ChangesPayload"];
export type Snapshot = components["schemas"]["SnapshotPayload"];
export type SyncBlock = components["schemas"]["SyncBlock"];
export type SyncPage = components["schemas"]["SyncPage"];

export type ApplyResult =
  | { status: "applied"; cursor: number }
  | { status: "needs-bootstrap" }
  | { status: "pending-changed" };

const upsertPage = (db: ReplicaDb, p: SyncPage): void => {
  reconcilePage(db, p); // offline-created page? remap its rows first
  db.exec(
    "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)" +
    " ON CONFLICT(id) DO UPDATE SET title = excluded.title," +
    " created_at = excluded.created_at, updated_at = excluded.updated_at",
    [p.id, p.title, p.created_at, p.updated_at]);
};

const upsertBlock = (db: ReplicaDb, b: SyncBlock): void => {
  db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text, heading," +
    " collapsed, created_at, updated_at, view_type) VALUES (?,?,?,?,?,?,?,?,?,?)" +
    " ON CONFLICT(uid) DO UPDATE SET page_id = excluded.page_id," +
    " parent_uid = excluded.parent_uid, order_idx = excluded.order_idx," +
    " text = excluded.text, heading = excluded.heading," +
    " collapsed = excluded.collapsed, created_at = excluded.created_at," +
    " updated_at = excluded.updated_at, view_type = excluded.view_type",
    [b.uid, b.page_id, b.parent_uid, b.order_idx, b.text, b.heading,
     b.collapsed, b.created_at, b.updated_at, b.view_type]);
  // refs are server-derived from the block's current text: replace wholesale
  db.exec("DELETE FROM refs WHERE src_block_uid = ?", [b.uid]);
  for (const r of b.refs) {
    db.exec("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
            [b.uid, r.target_page_id, r.kind] as SqlValue[]);
  }
};

export function applySnapshot(db: ReplicaDb, snap: Snapshot,
                              nowMs: number = Date.now()): void {
  db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys = ON");
    // wipe order respects FKs anyway (refs -> blocks -> pages)
    db.exec("DELETE FROM refs");
    db.exec("DELETE FROM blocks");
    db.exec("DELETE FROM pages");
    db.exec("DELETE FROM sidebar_entries");
    for (const p of snap.pages) upsertPage(db, p);
    for (const b of snap.blocks) upsertBlock(db, b);
    for (const s of snap.sidebar) {
      db.exec("INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?,?,?)",
              [s.id, s.title, s.order_idx]);
    }
    setMeta(db, "cursor", String(snap.seq));
    setMeta(db, "generation", snap.generation);
    reapplyPending(db, nowMs);
  });
}

/** Re-apply queued optimistic batches after an authoritative write.
 *
 * Any snapshot or feed window may overwrite state that queued batches had
 * applied optimistically (edits race their own echo through the sync
 * protocol on every bootstrap and pull). Losing that state doesn't just
 * revert the visible text — the NEXT update_text would capture a stale
 * base_text_hash and manufacture a spurious conflict copy server-side.
 * Re-applying is safe: batches flush to the server unchanged, and a batch
 * that can no longer apply (e.g. its rows were superseded or tombstoned)
 * is skipped via savepoint rollback — push-time resolution owns it. */
function reapplyPending(db: ReplicaDb, nowMs: number): void {
  for (const b of allBatches(db)) {
    if (b.poisoned) continue;
    db.exec("SAVEPOINT reapply_batch");
    try {
      applyLocalOps(db, b.ops, nowMs);
      db.exec("RELEASE reapply_batch");
    } catch {
      db.exec("ROLLBACK TO reapply_batch");
      db.exec("RELEASE reapply_batch");
    }
  }
}

export function applyChanges(db: ReplicaDb, feed: Changes,
                             nowMs: number = Date.now()): ApplyResult {
  if (feed.reset || feed.generation !== getMeta(db, "generation")) {
    // cursor from another life: a reset request, or a rebuilt database
    // whose journal restarted (pkm-o9o5). Never apply mid-journal rows.
    return { status: "needs-bootstrap" };
  }
  db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const p of feed.pages) upsertPage(db, p);
    for (const b of feed.blocks) upsertBlock(db, b);
    for (const s of feed.sidebar) {
      db.exec(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?,?,?)" +
        " ON CONFLICT(id) DO UPDATE SET title = excluded.title," +
        " order_idx = excluded.order_idx",
        [s.id, s.title, s.order_idx]);
    }
    for (const tomb of feed.tombstones) {
      if (tomb.kind === "block") {
        db.exec("DELETE FROM blocks WHERE uid = ?", [tomb.entity_id]);
      } else if (tomb.kind === "page") {
        db.exec("DELETE FROM pages WHERE id = ?", [Number(tomb.entity_id)]);
      } else {
        db.exec("DELETE FROM sidebar_entries WHERE id = ?",
                [Number(tomb.entity_id)]);
      }
    }
    setMeta(db, "cursor", String(feed.next_since));
    reapplyPending(db, nowMs);
  });
  return { status: "applied", cursor: feed.next_since };
}
