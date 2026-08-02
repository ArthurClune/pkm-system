// pattern: Imperative Shell
// Negative-id page reconciliation (spec section 3). Pages created offline
// get temporary negative ids; when the feed delivers the authoritative row
// for the same title, the negative row can't simply be upserted (it owns
// the UNIQUE title) and must not be deleted first with children attached
// (FK cascade would erase them). Inside the caller's window transaction
// (already running with defer_foreign_keys): remap children + refs, delete
// the negative row, and let the caller insert the authoritative row.

import type { SyncPage } from "./apply";
import type { ReplicaDb } from "./db";
import { plainSpaceTitleCanonicalizationActive } from "./meta";
import { canonicalizeTitle } from "./titles";

const remapLocalPage = (db: ReplicaDb, localId: number,
                        targetId: number): void => {
  db.exec("UPDATE blocks SET page_id = ? WHERE page_id = ?",
          [targetId, localId]);
  // OR REPLACE: a block may already carry the same (src, kind) ref to the
  // authoritative id — the remapped row replaces it instead of violating
  // the refs primary key
  db.exec("UPDATE OR REPLACE refs SET target_page_id = ?" +
          " WHERE target_page_id = ?", [targetId, localId]);
  db.exec("DELETE FROM pages WHERE id = ?", [localId]);
};

export function reconcilePage(db: ReplicaDb, incoming: SyncPage): void {
  const local = db.select<{ id: number }>(
    "SELECT id FROM pages WHERE title = ? AND id < 0", [incoming.title]);
  if (local.length === 0) return;
  remapLocalPage(db, local[0].id, incoming.id);
}

/** Reconcile optimistic pages created under pre-activation title rules.
 *
 * Accepted activation metadata is stored before this runs. Canonical targets
 * from the same feed therefore win when present; otherwise the negative page
 * is retitled in place. Either path preserves its blocks and refs while the
 * durable pending wire operations remain untouched for normal replay. */
export function reconcileActivationPageTitles(db: ReplicaDb): void {
  if (!plainSpaceTitleCanonicalizationActive(db)) return;
  const localPages = db.select<{ id: number; title: string }>(
    "SELECT id, title FROM pages WHERE id < 0 ORDER BY id");
  for (const local of localPages) {
    const title = canonicalizeTitle(local.title, true);
    if (title === local.title) continue;
    const targets = db.select<{ id: number }>(
      "SELECT id FROM pages WHERE title = ? AND id != ?" +
      " ORDER BY CASE WHEN id >= 0 THEN 0 ELSE 1 END, id LIMIT 1",
      [title, local.id]);
    if (targets.length === 0) {
      db.exec("UPDATE pages SET title = ? WHERE id = ?", [title, local.id]);
    } else {
      remapLocalPage(db, local.id, targets[0].id);
    }
  }
}
