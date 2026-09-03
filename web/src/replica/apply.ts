// pattern: Imperative Shell
// Feed application (spec sections 3 and 1): snapshot bootstrap and windowed
// changes upserts. Each window applies in ONE transaction, ordered tombstones
// -> pages -> blocks -> sidebar, under transaction-scoped deferred FKs so
// intra-window row order never matters for FKs; it matters for the UNIQUE
// titles, which is why tombstones lead and colliding titles are parked
// (applyWindow). Upserts are idempotent -- re-pulling any window is safe. The
// base schema's FTS triggers maintain the local search index on every upsert.
//
// Deferred FKs move every violation to the outer COMMIT, so neither the
// savepoints reapplyPending rolls back to nor a try/catch around a single op
// can see one (pkm-qvlx). Two guards keep that from wedging sync:
//   - reapplyPending diffs `PRAGMA foreign_key_check` around each batch and
//     rolls a batch back when it ADDS a violation, so an unappliable optimistic
//     batch is skipped like any other instead of poisoning the COMMIT. The
//     pragma reads violations whatever `foreign_keys`/`defer_foreign_keys` say,
//     so this also protects the reset rebuild, which runs with FKs off.
//   - applyChanges turns an FK failure at COMMIT into `needs-bootstrap` rather
//     than throwing: the window rolled back and the cursor never advanced, so
//     rethrowing would refetch the same dependency-incomplete window forever.
//     applySnapshot still throws -- a snapshot ships the whole graph, so a
//     dangling row in one means something is genuinely wrong.

import type { components } from "../api/types";
import { reindexBlockRefs } from "./blockRefs";
import type { ReplicaDb, SqlValue } from "./db";
import { applyLocalOps } from "./localOps";
import { getMeta, setMeta, setPlainSpaceTitleCanonicalization } from "./meta";
import { allBatches } from "./queue";
import { reconcileActivationPageTitles, reconcilePage } from "./reconcile";

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
  // block_refs are never shipped over sync (pkm-d31f): derived locally here
  // and in localOps.ts through the one composition (see blockRefs.ts).
  reindexBlockRefs(db, b.uid, b.text);
};

export function applySnapshot(db: ReplicaDb, snap: Snapshot,
                              nowMs: number = Date.now()): void {
  db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys = ON");
    // wipe order respects FKs anyway (refs -> blocks -> pages)
    db.exec("DELETE FROM refs");
    db.exec("DELETE FROM block_refs");
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
    setPlainSpaceTitleCanonicalization(
      db, snap.plain_space_title_canonicalization);
    reconcileActivationPageTitles(db);
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
 * Rejected batches remain durable only while repair is pending: they are
 * skipped here so the authoritative snapshot removes their optimistic effect,
 * then the provider deletes their rows before delivery resumes.
 * Re-applying is safe: batches flush to the server unchanged, and a batch
 * that can no longer apply (e.g. its rows were superseded or tombstoned)
 * is skipped via savepoint rollback — push-time resolution owns it. A batch
 * whose rows dangle counts as no-longer-applicable too: deferred FKs let the
 * ops themselves succeed, so the violation set is compared around each batch
 * (see the file header). Rows are never deleted here — the queue is the
 * user's intent and still flushes to the server. */
function reapplyPending(db: ReplicaDb, nowMs: number): void {
  const batches = allBatches(db).filter((b) => !b.poisoned);
  if (batches.length === 0) return; // nothing to reapply, nothing to check
  let before = fkViolations(db); // empty unless the feed itself dangles
  for (const b of batches) {
    db.exec("SAVEPOINT reapply_batch");
    let result: { after: Set<string> } | null;
    try {
      applyLocalOps(db, b.ops, nowMs);
      const after = fkViolations(db);
      result = addsFkViolation(before, after) ? null : { after };
    } catch {
      result = null;
    }
    if (result !== null) {
      // A kept batch added no violation, so `after` is always a subset of
      // `before` (it may also be a strict subset, if the batch's ops
      // happened to resolve one the feed itself shipped). Tightening the
      // baseline to it only ever shrinks what a later batch is allowed to
      // add -- it can't cause a batch that would otherwise be kept to be
      // rejected.
      before = result.after;
    } else {
      db.exec("ROLLBACK TO reapply_batch");
    }
    db.exec("RELEASE reapply_batch");
  }
}

/** Identities of the rows currently violating an FK. Readable inside a
 * transaction and independent of the enforcement pragmas, which is what makes
 * it usable under both deferred FKs and the reset path's `foreign_keys=OFF`.
 *
 * `PRAGMA foreign_key_check` reports `rowid = NULL` for a WITHOUT ROWID
 * child (`refs`, `block_refs`), so distinct violating rows on those tables
 * can collapse to the same Set key. That's acceptable here: a baseline
 * non-empty on those tables can only come from a windowed feed shipping a
 * dangling row (an un-upgraded or dependency-incomplete server) -- that
 * fails deferred enforcement at COMMIT regardless of what this pragma saw
 * mid-transaction (`isFkFailure`). It cannot arise on the reset path: that
 * path's snapshot always ships the whole graph, so every ref's target page
 * is in the same payload -- there is nothing left for this collapse to
 * hide.
 *
 * Deliberately unscoped. Narrowing it to `foreign_key_check(blocks)` looks
 * like a free win (reapplyPending calls this K+1 times per window) but is
 * not: `blocks`, `refs` and `block_refs` all bear FKs, so a correct scoped
 * check must run all three, and the unscoped pragma already visits only
 * FK-bearing tables -- measured at 1 000/5 000/20 000 blocks, whole-database
 * (0.32/1.72/7.54 ms) equals the sum of the three scoped checks
 * (0.32/1.72/7.41 ms) within noise (pkm-ey1f). Scoping to `blocks` alone
 * would drop exactly the two tables the paragraph above is about. */
const fkViolations = (db: ReplicaDb): Set<string> =>
  new Set(db.select<{ table: string; rowid: SqlValue; parent: string;
                      fkid: number }>("PRAGMA foreign_key_check")
    .map((v) => JSON.stringify([v.table, v.rowid, v.parent, v.fkid])));

const addsFkViolation = (before: Set<string>, after: Set<string>): boolean => {
  for (const v of after) if (!before.has(v)) return true;
  return false;
};

/** SQLite reports a deferred violation only at COMMIT, as SQLITE_CONSTRAINT_
 * FOREIGNKEY (787). Matched on the message because the wrapper surfaces the
 * engine's error object unchanged. */
const isFkFailure = (e: unknown): boolean => {
  const message = String(e); // "SQLite3Error: ... 787: FOREIGN KEY constraint failed"
  return /FOREIGN KEY constraint failed/i.test(message)
      || /\bresult code 787\b/.test(message);
};

export function applyChanges(db: ReplicaDb, feed: Changes,
                             nowMs: number = Date.now()): ApplyResult {
  if (feed.reset || feed.generation !== getMeta(db, "generation")) {
    // cursor from another life: a reset request, or a rebuilt database
    // whose journal restarted (pkm-o9o5). Never apply mid-journal rows.
    return { status: "needs-bootstrap" };
  }
  try {
    applyWindow(db, feed, nowMs);
  } catch (e) {
    if (e instanceof StaleTitleHolderError) {
      // A local row still holds a title this window handed to another id,
      // and nothing in the window retitles or deletes it. The server cannot
      // hold two rows with one title, so the replica's picture of that row
      // is stale in a way no later window will correct (its own change was
      // in a window we already applied, or never journalled). Rebuild.
      console.warn("applyChanges: stale title holder, rebootstrapping", e);
      return { status: "needs-bootstrap" };
    }
    if (!isFkFailure(e)) throw e;
    // The window depends on rows it never shipped (an un-upgraded server, or
    // one that predates the parent-completion fix). The transaction rolled
    // back, cursor included, so retrying the pull would refetch this same
    // window forever. Bootstrap past it instead.
    //
    // Narrowing this catch to "a COMMIT-time deferred FK failure, and
    // nothing else" depends on `PRAGMA defer_foreign_keys = ON` being the
    // very first statement applyWindow's transaction runs: with nothing
    // ahead of it to enforce FKs immediately, no statement in the body can
    // raise 787 -- only the COMMIT can. Moving that pragma out of first
    // place would let an in-body statement throw the same error this catch
    // assumes only COMMIT can produce.
    console.warn(
      "applyChanges: window failed its deferred FK check, rebootstrapping",
      e);
    return { status: "needs-bootstrap" };
  }
  return { status: "applied", cursor: feed.next_since };
}

/** Thrown inside the window transaction (so it rolls back) when a parked
 * title (see parkTakenTitles) is still parked after every upsert ran. */
class StaleTitleHolderError extends Error {
  constructor(table: string, ids: number[]) {
    super(`${table} rows ${ids.join(",")} hold titles this window gave to` +
          " other ids and are neither retitled nor tombstoned in it");
    this.name = "StaleTitleHolderError";
  }
}

/** A title no server row can carry: titles are control-normalized at every
 * boundary, so a C0 control character never arrives in a feed. Parked rows
 * exist only inside the window transaction -- either their own upsert
 * overwrites the title, or the transaction rolls back
 * (StaleTitleHolderError). U+0001, not NUL: SQLite's string functions treat
 * an embedded NUL as a terminator. */
const parkedTitle = (id: number): string => `parked:${String(id)}`;

type TitledTable = "pages" | "sidebar_entries";

/** `pages.title` and `sidebar_entries.title` are UNIQUE, and a window is a
 * set of CURRENT rows: it can carry two rows that traded titles, or a
 * tombstone for the row that used to own a title beside the row that took it
 * over. Tombstones are applied before upserts (applyWindow), which covers the
 * second shape; this covers the first. For each incoming row, any OTHER
 * positive-id local row holding its title is moved to a placeholder first, so
 * the upsert lands, and the holder's own upsert (later in the same window)
 * restores its real title. Negative ids are offline-created pages, which
 * reconcilePage remaps rather than retitles. Rows still parked once every
 * upsert has run are a stale replica, not a swap -- see the check in
 * applyWindow. */
function parkTakenTitles(db: ReplicaDb, table: TitledTable,
                         incoming: readonly { id: number; title: string }[]): number[] {
  const parked: number[] = [];
  for (const row of incoming) {
    const holders = db.select<{ id: number }>(
      `SELECT id FROM ${table} WHERE title = ? AND id != ? AND id >= 0`,
      [row.title, row.id]);
    for (const holder of holders) {
      db.exec(`UPDATE ${table} SET title = ? WHERE id = ?`,
              [parkedTitle(holder.id), holder.id]);
      parked.push(holder.id);
    }
  }
  return parked;
}

function assertNoParkedTitles(db: ReplicaDb, table: TitledTable,
                              parked: readonly number[]): void {
  const still = parked.filter((id) => db.select(
    `SELECT 1 AS x FROM ${table} WHERE id = ? AND title = ?`,
    [id, parkedTitle(id)]).length > 0);
  if (still.length > 0) throw new StaleTitleHolderError(table, still);
}

/** Order inside the window transaction: tombstones, then pages, blocks and
 * sidebar upserts, then the queue replay. Deferred FKs make the order
 * irrelevant for referential integrity; it is the UNIQUE titles that fix it.
 * A row that gave a title up by being deleted must be gone before the row
 * that took the title arrives, so tombstones go first (pkm-n31j). A page
 * tombstone cascades to its local blocks; any of those that survived
 * server-side (moved to another page) come back through the block upserts
 * that follow, because the feed hydrates current rows. */
function applyWindow(db: ReplicaDb, feed: Changes, nowMs: number): void {
  db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys = ON");
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
    const parkedPages = parkTakenTitles(db, "pages", feed.pages);
    for (const p of feed.pages) upsertPage(db, p);
    assertNoParkedTitles(db, "pages", parkedPages);
    for (const b of feed.blocks) upsertBlock(db, b);
    const parkedSidebar = parkTakenTitles(db, "sidebar_entries", feed.sidebar);
    for (const s of feed.sidebar) {
      db.exec(
        "INSERT INTO sidebar_entries(id, title, order_idx) VALUES (?,?,?)" +
        " ON CONFLICT(id) DO UPDATE SET title = excluded.title," +
        " order_idx = excluded.order_idx",
        [s.id, s.title, s.order_idx]);
    }
    assertNoParkedTitles(db, "sidebar_entries", parkedSidebar);
    setMeta(db, "cursor", String(feed.next_since));
    setPlainSpaceTitleCanonicalization(
      db, feed.plain_space_title_canonicalization);
    reconcileActivationPageTitles(db);
    reapplyPending(db, nowMs);
  });
}
