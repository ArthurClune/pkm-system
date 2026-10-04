// pattern: Imperative Shell
// Feed application (spec sections 3 and 1): snapshot bootstrap and windowed
// changes upserts. Each window applies in ONE transaction, ordered page and
// sidebar tombstones -> pages -> blocks -> block tombstones -> sidebar, under
// transaction-scoped deferred FKs so intra-window row order never matters for
// FKs; it matters for the UNIQUE titles, which is why page and sidebar
// tombstones lead and colliding titles are parked, and for the block
// cascade, which is why block tombstones follow the upserts and wait for the
// window that reaches the journal head (applyWindow).
// Upserts are idempotent -- re-pulling any window is safe. The
// base schema's FTS triggers maintain the local search index on every upsert.
//
// Deferred FKs move every violation to the outer COMMIT, so neither the
// savepoints reapplyPending rolls back to nor a try/catch around a single op
// can see one. Two guards keep that from wedging sync:
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

import type { BlockUid, CanonicalTitle, PageId, SidebarEntryId,
              SyncSeq } from "../api/brands";
import type { components } from "../api/types";
import { appliedPendingRows } from "./ackedRows";
import { reindexBlockRefs } from "./blockRefs";
import type { DroppedBatch, PendingRowId } from "./client";
import { type ReplicaDb, rollbackToSavepoint, type SqlValue } from "./db";
import { applyLocalOps } from "./localOps";
import { deleteMeta, getMeta, setMeta,
         setPlainSpaceTitleCanonicalization } from "./meta";
import { allBatches, deleteBatch } from "./queue";
import { reconcileActivationPageTitles, reconcilePage } from "./reconcile";

export type Changes = components["schemas"]["ChangesPayload"];
export type Snapshot = components["schemas"]["SnapshotPayload"];
export type SyncBlock = components["schemas"]["SyncBlock"];
export type SyncPage = components["schemas"]["SyncPage"];
export type SyncTombstone = components["schemas"]["SyncTombstone"];

type AppliedBatch = components["schemas"]["AppliedBatch"];

/** `dropped` lists the pending rows the window named as already applied and
 * deleted (see dropAppliedPending); it is absent when there were none. */
export type ApplyResult =
  | { status: "applied"; cursor: SyncSeq; dropped?: readonly DroppedBatch[] }
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
  // block_refs are never shipped over sync: derived locally here
  // and in localOps.ts through the one composition (see blockRefs.ts).
  reindexBlockRefs(db, b.uid, b.text);
};

/** The pending rows a payload names in `applied_batches` (the batch is
 * already in the server's applied_batches as of the read that hydrated the
 * payload), deleted before the replay; see appliedPendingRows for which rows
 * qualify.
 *
 * A batch's writes and its applied_batches row commit together, so a named
 * batch is one whose effects the payload's rows already show, however its
 * ack is faring. Replaying it would apply it a second time: reapplyPending's
 * per-op keep rules hold only while nothing after an op moved its target,
 * and a later op of the same batch, a later batch, or another device's edit
 * can. The payload is the batch's echo, so nothing would re-ship the rows it
 * damaged. Deleting the row here is what the drain does on the ack; its
 * caller settles the row's delivery as the ack would. A window whose
 * transaction rolls back keeps the rows. */
function dropAppliedPending(db: ReplicaDb,
                            applied: readonly AppliedBatch[] | undefined,
                            droppable?: readonly PendingRowId[]): DroppedBatch[] {
  if (applied === undefined || applied.length === 0) return [];
  const dropped = appliedPendingRows(
    allBatches(db), applied,
    droppable === undefined ? undefined : new Set(droppable));
  for (const row of dropped) deleteBatch(db, row.id, row.batch_id);
  return dropped;
}

/** Returns the pending rows the snapshot named as applied and deleted. */
export function applySnapshot(db: ReplicaDb, snap: Snapshot,
                              nowMs: number = Date.now()): DroppedBatch[] {
  return db.transaction(() => {
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
    deleteMeta(db, DEFERRED_BLOCK_TOMBSTONES); // the snapshot is the whole state
    setPlainSpaceTitleCanonicalization(
      db, snap.plain_space_title_canonicalization);
    reconcileActivationPageTitles(db);
    const dropped = dropAppliedPending(db, snap.applied_batches);
    reapplyPending(db, nowMs);
    return dropped;
  });
}

/** Re-apply queued optimistic batches after an authoritative write.
 *
 * Any snapshot or feed window may overwrite state that queued batches had
 * applied optimistically (edits race their own echo through the sync
 * protocol on every bootstrap and pull). Losing that state doesn't just
 * revert the visible text — the NEXT update_text would capture a stale
 * base_text_hash and manufacture a spurious daily-note conflict header
 * server-side.
 * Rejected batches remain durable only while repair is pending: they are
 * skipped here so the authoritative snapshot removes their optimistic effect,
 * then the provider deletes their rows before delivery resumes.
 * A replayed batch is one the server has not acknowledged: a rebase commit
 * deletes the batches its flush got acks for before the snapshot applies,
 * since what the server saved for them can differ from their wire text, and
 * a payload's applied_batches deletes the batches it already holds
 * (dropAppliedPending). The
 * batches replayed here still flush to the server unchanged. An op whose
 * block or parent the feed removed is skipped inside applyLocalOps, as the
 * server skips it, so the rest of its batch still lands. A window
 * does not wipe first, so its replay runs over the batch's own effects:
 * `reapply` keeps a create's existing row and an already-placed move where
 * they are rather than failing the insert or shifting siblings again. A
 * batch that still cannot apply (applyLocalOps throws) is skipped whole via
 * savepoint rollback — push-time resolution owns it. A batch
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
    let failure: unknown;
    try {
      applyLocalOps(db, b.ops, nowMs, { reapply: true });
      const after = fkViolations(db);
      result = addsFkViolation(before, after) ? null : { after };
    } catch (error: unknown) {
      result = null;
      failure = error;
    }
    if (result !== null) {
      // A kept batch added no violation, so `after` is always a subset of
      // `before` (it may also be a strict subset, if the batch's ops
      // happened to resolve one the feed itself shipped). Tightening the
      // baseline to it only ever shrinks what a later batch is allowed to
      // add -- it can't cause a batch that would otherwise be kept to be
      // rejected.
      //
      // Tightening is also what stops a DELETE-freed rowid from masking a
      // later batch's dangling insert: `blocks` has no AUTOINCREMENT, so a
      // rowid this batch's own delete just freed can be handed straight back
      // out by the next batch's insert, reproducing the identical
      // foreign_key_check key ([blocks, rowid, blocks, fkid]) the deleted
      // row used to report. Leaving `before` untightened would still contain
      // that key and wave the reused-rowid insert through as "no new
      // violation". Reuse WITHIN one batch (a delete and a
      // dangling insert together) still slips past this -- but that's
      // harmless: it needs the window's own dangling row already in the
      // baseline, which fails the deferred COMMIT regardless and falls back
      // to needs-bootstrap; on the snapshot/reset path the baseline starts
      // empty, so there is nothing to hide behind there either.
      before = result.after;
    } else {
      rollbackToSavepoint(db, "reapply_batch", failure);
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
 * (0.32/1.72/7.41 ms) within noise. Scoping to `blocks` alone
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

/** `droppable`: the pending rows the pull read when it named its pending
 * batches to the server. Only those may be dropped as already applied; when
 * omitted, any row the feed names may be. */
export function applyChanges(db: ReplicaDb, feed: Changes,
                             nowMs: number = Date.now(),
                             { droppable }: { droppable?: readonly PendingRowId[] } = {},
): ApplyResult {
  if (feed.reset || feed.generation !== getMeta(db, "generation")) {
    // cursor from another life: a reset request, or a rebuilt database
    // whose journal restarted. Never apply mid-journal rows.
    return { status: "needs-bootstrap" };
  }
  let dropped: DroppedBatch[];
  try {
    dropped = applyWindow(db, feed, nowMs, droppable);
  } catch (e) {
    if (e instanceof StaleTitleHolderError) {
      // A local row still holds a title this window handed to another id,
      // and nothing in the window retitles or deletes it. The server cannot
      // hold two rows with one title, so either the replica's picture of
      // that row is stale (its change was in a window already applied) or
      // its retitle lies past this window's end. No later window is
      // guaranteed to correct the first; a snapshot corrects both. Rebuild.
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
  return dropped.length > 0
    ? { status: "applied", cursor: feed.next_since, dropped }
    : { status: "applied", cursor: feed.next_since };
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

/** The placeholder a parked row carries. Nothing rejects U+0001 in a title
 * (the normalizers only touch whitespace controls), so this is a title no
 * user would type rather than one the server cannot hold; a real title of
 * exactly this shape would collide, and that is accepted. Parked rows exist
 * only inside the window transaction -- either their own upsert overwrites
 * the title, or the transaction rolls back (StaleTitleHolderError). U+0001,
 * not NUL: SQLite's string functions treat an embedded NUL as a terminator.
 * Its own type, never a CanonicalTitle: it is no title the server holds, so
 * no row read that types `title` canonical may run while one is parked. */
type ParkedTitle = string & { readonly __brand: "ParkedTitle" };

const parkedTitle = (id: PageId | SidebarEntryId): ParkedTitle =>
  `parked:${String(id)}` as ParkedTitle;

/** Ties an id type to its own table, so a pages call and a sidebar call
 * below can't take each other's table literal: `Id` is inferred from the
 * `incoming`/`parked` rows, and the conditional type then checks `table`
 * against it, where a plain `"pages" | "sidebar_entries"` union could not. */
type TitledTableFor<Id extends PageId | SidebarEntryId> =
  Id extends PageId ? "pages" : "sidebar_entries";

/** `pages.title` and `sidebar_entries.title` are UNIQUE, and a window is a
 * set of CURRENT rows: it can carry two rows that traded titles, or a
 * tombstone for the row that used to own a title beside the row that took it
 * over. Page and sidebar tombstones are applied before upserts (applyWindow),
 * which covers the second shape; this covers the first. For each incoming row, any OTHER
 * positive-id local row holding its title is moved to a placeholder first, so
 * the upsert lands, and the holder's own upsert (later in the same window)
 * restores its real title. Negative ids are offline-created pages, which
 * reconcilePage remaps rather than retitles. Rows still parked once every
 * upsert has run are not a swap -- see the check in applyWindow. */
export function parkTakenTitles<Id extends PageId | SidebarEntryId>(
    db: ReplicaDb, table: TitledTableFor<Id>,
    incoming: readonly { id: Id; title: CanonicalTitle }[]): Id[] {
  const parked: Id[] = [];
  for (const row of incoming) {
    const holders = db.select<{ id: Id }>(
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

export function assertNoParkedTitles<Id extends PageId | SidebarEntryId>(
    db: ReplicaDb, table: TitledTableFor<Id>, parked: readonly Id[]): void {
  const still = parked.filter((id) => db.select(
    `SELECT 1 AS x FROM ${table} WHERE id = ? AND title = ?`,
    [id, parkedTitle(id)]).length > 0);
  if (still.length > 0) throw new StaleTitleHolderError(table, still);
}

/** Deletes one tombstone's row; its FK cascades take what hangs off it. */
function applyTombstone(db: ReplicaDb, tomb: SyncTombstone): void {
  if (tomb.kind === "block") {
    // entity_id is one TEXT wire field for three kinds; a block
    // tombstone's value is a block uid.
    db.exec("DELETE FROM blocks WHERE uid = ?",
            [tomb.entity_id as BlockUid]);
  } else if (tomb.kind === "page") {
    db.exec("DELETE FROM pages WHERE id = ?",
            [Number(tomb.entity_id) as PageId]);
  } else if (tomb.kind === "sidebar") {
    db.exec("DELETE FROM sidebar_entries WHERE id = ?",
            [Number(tomb.entity_id) as SidebarEntryId]);
  } else {
    // A kind this build doesn't know (an older replica meeting a kind a
    // newer server added): skip it rather than fall through to a
    // sidebar delete, which would destroy an unrelated row. The `never`
    // assignment makes an unhandled EntityKind a compile error here.
    const unhandled: never = tomb.kind;
    console.warn("applyWindow: unknown tombstone kind, skipping",
                 unhandled);
  }
}

/** The sync_client_meta key holding the block tombstones a catch-up has
 * received short of the journal head and not yet applied (applyWindow). */
const DEFERRED_BLOCK_TOMBSTONES = "deferred_block_tombstones";

/** The block tombstones still owed after a window: those recorded by
 * earlier windows, less any block this window ships live (a uid an undo
 * recreated after its tombstone was read), then this window's, once each,
 * in order. */
function owedBlockTombstones(recorded: string | null,
                             shipped: readonly SyncBlock[],
                             tombstoned: readonly BlockUid[]): BlockUid[] {
  const live = new Set(shipped.map((b) => b.uid));
  const earlier = recorded === null ? [] : JSON.parse(recorded) as BlockUid[];
  return [...new Set([...earlier.filter((u) => !live.has(u)), ...tombstoned])];
}

/** Order inside the window transaction: page and sidebar tombstones, then
 * pages and blocks, then block tombstones (in the window at the journal
 * head only, below), then sidebar upserts, then dropping the pending rows
 * the window names as applied, then the queue replay. Deferred FKs make
 * the order irrelevant for referential integrity; the UNIQUE titles and
 * the local cascades fix it.
 *
 * Page and sidebar tombstones lead. A row that gave a title up by being
 * deleted must be gone before the row that took the title arrives. A page
 * id the server deleted and reused inside the window arrives as both a
 * tombstone and a live row: the tombstone's cascade clears the old page's
 * blocks and every ref to the id, and the server ships every current block
 * on or referencing that page in the same window, so every block the
 * server still has there is back by COMMIT. A page cascade never removes a
 * block the server kept for good: a block leaves a page only by a write to
 * its own row (every block of a moved subtree gets the new page_id), so
 * the block upserts that follow bring it back. A block an earlier window
 * hydrated onto the page, and which has left it since, returns with its
 * own later journal row.
 *
 * Block tombstones apply only in the window that reaches the journal head
 * (`next_since >= latest_seq`, pullLoop's own test for done), after its
 * upserts. A window short of the head records its block tombstones in
 * sync_client_meta instead, in the transaction that advances the cursor, so
 * a restart mid-catch-up cannot leave the cursor past a tombstone nobody
 * applied; the window at the head applies every recorded one with its own.
 * The cascade must not reach a block the server kept. A kept block may be a
 * descendant that moved along with a moved-out ancestor: its own row never
 * changed, so only the ancestor's row ships, and nothing would re-ship it
 * once the cascade had taken it. Cascading per window fails when that
 * ancestor is itself deleted in a later window: its move row ships nothing
 * (it is absent now), so the earlier window's cascade would run over the
 * replica's stale subtree. Once the head window's upserts have run, every
 * block the server still has is placed either by its own shipped row or
 * under an unchanged parent chain of blocks the server also still has, so
 * none sits under a deleted block, and the cascade over that tree is the
 * one-window case. Between windows the replica only looks older (deleted
 * blocks stay visible), never wrongly shaped. A recorded block a later
 * window ships live (an undo recreated it after its tombstone was read)
 * is dropped from the record. Block uids are never reused, so no block is
 * both tombstoned and shipped live in one window. The cascade still removes
 * optimistic rows under a deleted block (a pending create's ghost), and the
 * replay then skips the op as the server does. */
function applyWindow(db: ReplicaDb, feed: Changes, nowMs: number,
                     droppable?: readonly PendingRowId[]): DroppedBatch[] {
  return db.transaction(() => {
    db.exec("PRAGMA defer_foreign_keys = ON");
    const recorded = getMeta(db, DEFERRED_BLOCK_TOMBSTONES);
    const owed = owedBlockTombstones(
      recorded, feed.blocks,
      feed.tombstones.filter((tm) => tm.kind === "block")
        .map((tm) => tm.entity_id as BlockUid));
    const atHead = feed.next_since >= feed.latest_seq;
    for (const tomb of feed.tombstones) {
      if (tomb.kind !== "block") applyTombstone(db, tomb);
    }
    const parkedPages = parkTakenTitles(db, "pages", feed.pages);
    for (const p of feed.pages) upsertPage(db, p);
    assertNoParkedTitles(db, "pages", parkedPages);
    for (const b of feed.blocks) upsertBlock(db, b);
    if (atHead) {
      for (const u of owed) applyTombstone(db, { kind: "block", entity_id: u });
    }
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
    if (!atHead && owed.length > 0) {
      setMeta(db, DEFERRED_BLOCK_TOMBSTONES, JSON.stringify(owed));
    } else if (recorded !== null) {
      deleteMeta(db, DEFERRED_BLOCK_TOMBSTONES);
    }
    setPlainSpaceTitleCanonicalization(
      db, feed.plain_space_title_canonicalization);
    reconcileActivationPageTitles(db);
    const dropped = dropAppliedPending(db, feed.applied_batches, droppable);
    reapplyPending(db, nowMs);
    return dropped;
  });
}
