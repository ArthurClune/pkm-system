// pattern: Imperative Shell
// The replica's half of the "block_refs is derived from block text" invariant
// (pkm-d31f). block_refs rows are never shipped over sync -- targets are uids
// needing no id resolution, and the extractor is parity-pinned against the
// server (shared/fixtures/refs_parity.json) -- so every path that writes a
// block's text re-derives them locally: apply.ts on remote apply (snapshot
// bootstrap and change windows) and localOps.ts on optimistic local apply.
// One composition so those two can't drift (pkm-t3qw).

import type { ReplicaDb } from "./db";
import { extractRefs, type ExtractedRefs } from "./refs";

/** Replace one block's outgoing ((uid)) rows from its text.
 *
 * Targets may dangle: an unresolved ((uid)) is a legal state that renders
 * unresolved, so there is no existence check and no FK. Never opens a
 * transaction -- both call sites already run inside one they own, and the
 * delete plus inserts must land together.
 *
 * Returns the parse so a caller that also rebuilds `refs` (localOps.ts, which
 * resolves [[titles]] onto local page ids) reads the text once. The two
 * tables are independent -- no FK between them, no triggers on either -- so
 * the order in which a caller writes them is not observable.
 */
export function reindexBlockRefs(db: ReplicaDb, uid: string,
                                 text: string): ExtractedRefs {
  const parsed = extractRefs(text);
  db.exec("DELETE FROM block_refs WHERE src_block_uid = ?", [uid]);
  for (const target of parsed.blockRefs) {
    db.exec("INSERT OR IGNORE INTO block_refs VALUES (?,?)", [uid, target]);
  }
  return parsed;
}
