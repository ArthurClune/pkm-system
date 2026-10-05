// pattern: Imperative Shell
// Negative-id page reconciliation (spec section 3). Pages created offline
// get temporary negative ids; when the feed delivers the authoritative row
// for the same title, the negative row can't simply be upserted (it owns
// the UNIQUE title) and must not be deleted first with children attached
// (FK cascade would erase them). Inside the caller's window transaction
// (already running with defer_foreign_keys): remap children + refs, delete
// the negative row, and let the caller insert the authoritative row.

import type { PageId } from "../api/brands";
import type { SyncPage } from "./apply";
import { titleForDate } from "./daily";
import type { ReplicaDb } from "./db";
import { titleReader } from "./meta";
import { remapLogPage } from "./replayLog";

/** A named-object parameter, not two positional PageIds: a brand alone can't
 * tell `localId` and `targetId` apart, since both are the same type. */
export const remapLocalPage = (db: ReplicaDb,
                        { localId, targetId }: { localId: PageId; targetId: PageId }): void => {
  db.exec("UPDATE blocks SET page_id = ? WHERE page_id = ?",
          [targetId, localId]);
  // OR REPLACE: a block may already carry the same (src, kind) ref to the
  // authoritative id — the remapped row replaces it instead of violating
  // the refs primary key
  db.exec("UPDATE OR REPLACE refs SET target_page_id = ?" +
          " WHERE target_page_id = ?", [targetId, localId]);
  remapLogPage(db, { localId, targetId });
  db.exec("DELETE FROM pages WHERE id = ?", [localId]);
};

export function reconcilePage(db: ReplicaDb, incoming: SyncPage): void {
  const local = db.select<{ id: PageId }>(
    "SELECT id FROM pages WHERE title = ? AND id < 0", [incoming.title]);
  if (local.length === 0) return;
  remapLocalPage(db, { localId: local[0].id, targetId: incoming.id });
}

/** Reconcile optimistic pages created under pre-activation title rules.
 *
 * Accepted activation metadata is stored before this runs. Canonical targets
 * from the same feed therefore win when present; otherwise the negative page
 * is retitled in place. Either path preserves its blocks and refs while the
 * durable pending wire operations remain untouched for normal replay. */
export function reconcileActivationPageTitles(db: ReplicaDb): void {
  const read = titleReader(db);
  if (!read.plainSpaceActive) return;
  // Not CanonicalTitle: these rows were titled under the pre-activation
  // rules, and finding the ones that are no longer canonical is the point.
  const localPages = db.select<{ id: PageId; title: string }>(
    "SELECT id, title FROM pages WHERE id < 0 ORDER BY id");
  for (const local of localPages) {
    const title = read(local.title);
    if (title === local.title) continue;
    const targets = db.select<{ id: PageId }>(
      "SELECT id FROM pages WHERE title = ? AND id != ?" +
      " ORDER BY CASE WHEN id >= 0 THEN 0 ELSE 1 END, id LIMIT 1",
      [title, local.id]);
    if (targets.length === 0) {
      db.exec("UPDATE pages SET title = ? WHERE id = ?", [title, local.id]);
    } else {
      remapLocalPage(db, { localId: local.id, targetId: targets[0].id });
    }
  }
}

/** Delete every negative-id page nothing keeps: no block on it, no ref to
 * it, no replay-log record naming it (a pending batch's replay made or
 * touched it, or a rewind may put a block or ref back on it), and not
 * today's daily page (a read makes that one locally, with no op behind
 * it). A pending create_page records its page even when the page exists,
 * so a page only that op holds is kept; a poisoned batch is not replayed,
 * so it records nothing.
 *
 * reconcilePage matches a local page to the feed's only by title, so a
 * local page the server never made under that title is never matched: the
 * server renamed the page before the pull, or skipped the op that made it.
 * Its blocks leave it by their own rows; this removes the page they leave
 * behind. Run after the window's block tombstones and the queue replay, so
 * a block whose tombstone is deferred still keeps its page and a replayed
 * op has re-made whatever it needs. Call it only for the window at the
 * journal head: short of it, an acked batch's frozen records may still put
 * a block back on the page, and the server's page for it has not
 * necessarily arrived yet. Positive ids are the server's and are never
 * touched. */
export function dropStrandedLocalPages(db: ReplicaDb, nowMs: number): void {
  db.exec(
    "DELETE FROM pages AS p WHERE id < 0 AND title != ?" +
    " AND NOT EXISTS (SELECT 1 FROM blocks WHERE page_id = p.id)" +
    " AND NOT EXISTS (SELECT 1 FROM refs WHERE target_page_id = p.id)" +
    " AND NOT EXISTS (SELECT 1 FROM replay_log" +
    "                  WHERE (kind = 'page' AND key = CAST(p.id AS TEXT))" +
    "                     OR pre_page_id = p.id)" +
    " AND NOT EXISTS (SELECT 1 FROM replay_log_refs WHERE target_page_id = p.id)",
    [titleForDate(new Date(nowMs))]);
}
