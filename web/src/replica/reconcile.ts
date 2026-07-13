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

export function reconcilePage(db: ReplicaDb, incoming: SyncPage): void {
  const local = db.select<{ id: number }>(
    "SELECT id FROM pages WHERE title = ? AND id < 0", [incoming.title]);
  if (local.length === 0) return;
  const negId = local[0].id;
  db.exec("UPDATE blocks SET page_id = ? WHERE page_id = ?",
          [incoming.id, negId]);
  // OR REPLACE: a block may already carry the same (src, kind) ref to the
  // authoritative id — the remapped row replaces it instead of violating
  // the refs primary key
  db.exec("UPDATE OR REPLACE refs SET target_page_id = ?" +
          " WHERE target_page_id = ?", [incoming.id, negId]);
  db.exec("DELETE FROM pages WHERE id = ?", [negId]);
}
