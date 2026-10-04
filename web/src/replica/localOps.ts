// pattern: Imperative Shell
// Optimistic application of the editor's own ops to the replica (spec
// section 3): while offline the user's edits must render locally,
// including in backlinks and search, before the server ever sees them.
// This mirrors the server's ops_core/ops_apply semantics minus conflict
// handling — a local apply is always clean (the server resolves conflicts
// at push time). Pages referenced or created locally get temporary
// NEGATIVE ids, reconciled when the feed delivers the authoritative row
// (reconcile.ts); ops carry titles, so negative ids never go on the wire.
// An op on a missing block or create/move parent is skipped, as the server
// skips it (missingTarget.ts), and so is a move that would nest
// a block under itself or its own descendant. Where a create or move
// lands, including a re-applied batch (reapply) keeping its own effects
// in place, is placementFor's verdict (placement.ts); this file runs it.

import type { BlockUid, CanonicalTitle, OrderIdx, PageId } from "../api/brands";
import type { BlockOp, CreateOp, MoveOp } from "../api/ops";
import { reindexBlockRefs } from "./blockRefs";
import type { ReplicaDb } from "./db";
import { type TitleReader, titleReader } from "./meta";
import { skipsOnMissingTarget } from "./missingTarget";
import { type Placement, type PlacementFacts, placementFor } from "./placement";
import { findOpTitleViolation, type OpTitleViolation,
         titleSyntaxReason } from "./titles";

export class LocalOpError extends Error {
  /** Read by serveRpc onto the wire error: this is the replica refusing the OP,
   * not failing to store it, so the op queue must not retain and retry it —
   * the server would refuse it too. */
  readonly rejected = true;
  readonly opIndex?: number;
  readonly source?: OpTitleViolation["source"];
  readonly title?: string;

  constructor(message: string, violation?: OpTitleViolation) {
    super(message);
    this.name = "LocalOpError";
    if (violation !== undefined) {
      this.opIndex = violation.opIndex;
      this.source = violation.source;
      this.title = violation.title;
    }
  }
}

const titleViolationError = (violation: OpTitleViolation): LocalOpError =>
  new LocalOpError(
    `unsupported ${violation.source} title syntax: ${JSON.stringify(violation.title)}`,
    violation,
  );

/** The title a page is stored under: canonicalised, blank as "Untitled". */
export const storedPageTitle = (read: TitleReader,
                                title: string): CanonicalTitle => {
  const canonical = read(title);
  return canonical.trim().length === 0 ? read("Untitled") : canonical;
};

const localPageTitle = (db: ReplicaDb, title: string): CanonicalTitle =>
  storedPageTitle(titleReader(db), title);

const pageIdByTitle = (db: ReplicaDb, title: CanonicalTitle): PageId | null => {
  const rows = db.select<{ id: PageId }>(
    "SELECT id FROM pages WHERE title = ?", [title]);
  return rows.length > 0 ? rows[0].id : null;
};

/** The page getOrCreateLocalPage would return for `title`, if it exists
 * already; never creates one. */
const existingLocalPageId = (db: ReplicaDb, title: string):
  PageId | null => pageIdByTitle(db, localPageTitle(db, title));

export function getOrCreateLocalPage(db: ReplicaDb, requested: string,
                                     nowMs: number): PageId {
  const title = localPageTitle(db, requested);
  if (titleSyntaxReason(title) !== null) {
    throw new LocalOpError(`unsupported page title syntax: ${JSON.stringify(title)}`);
  }
  const existing = pageIdByTitle(db, title);
  if (existing !== null) return existing;
  const next = db.select<{ id: PageId }>(
    "SELECT MIN(0, COALESCE((SELECT MIN(id) FROM pages), 0)) - 1 AS id")[0].id;
  db.exec(
    "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
    [next, title, nowMs, nowMs]);
  return next;
}

const reindexRefs = (db: ReplicaDb, uid: BlockUid, text: string,
                     nowMs: number): void => {
  // The block-level index is the composition apply.ts
  // shares; it hands back the parse so the page-level refs below reuse it.
  const { refs } = reindexBlockRefs(db, uid, text);
  db.exec("DELETE FROM refs WHERE src_block_uid = ?", [uid]);
  for (const ref of refs) {
    const pageId = getOrCreateLocalPage(db, ref.title, nowMs);
    db.exec("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
            [uid, pageId, ref.kind]);
  }
};

const touchPage = (db: ReplicaDb, pageId: PageId, nowMs: number): void => {
  db.exec("UPDATE pages SET updated_at = ? WHERE id = ?", [nowMs, pageId]);
};

const shiftSiblings = (db: ReplicaDb, pageId: PageId,
                       parentUid: BlockUid | null,
                       fromOrderIdx: OrderIdx): void => {
  db.exec(
    "UPDATE blocks SET order_idx = order_idx + 1" +
    " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ?",
    [pageId, parentUid, fromOrderIdx]);
};

interface BlockInfo {
  page_id: PageId; parent_uid: BlockUid | null; order_idx: OrderIdx;
}

const blockInfo = (db: ReplicaDb, uid: BlockUid): BlockInfo | null => {
  const rows = db.select<BlockInfo>(
    "SELECT page_id, parent_uid, order_idx FROM blocks WHERE uid = ?", [uid]);
  return rows.length > 0 ? rows[0] : null;
};

/** Replay of a create or move already in place: shifting again would drift
 * every later sibling's order_idx on each feed window, until a sibling the
 * feed re-ships at its server index overtakes one that drifted. Shift only
 * when a sibling the window re-shipped now shares this block's slot. */
const keepSlot = (db: ReplicaDb, uid: BlockUid, at: BlockInfo): void => {
  const clash = db.select(
    "SELECT 1 AS x FROM blocks WHERE page_id = ? AND parent_uid IS ?" +
    " AND order_idx = ? AND uid != ? LIMIT 1",
    [at.page_id, at.parent_uid, at.order_idx, uid]);
  if (clash.length === 0) return;
  db.exec(
    "UPDATE blocks SET order_idx = order_idx + 1" +
    " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ? AND uid != ?",
    [at.page_id, at.parent_uid, at.order_idx, uid]);
};

/** uid and every ancestor above it; the visited-path guard stops on a
 * loop already in the replica, as ops_apply._parent_chain does. */
const parentChain = (db: ReplicaDb, uid: BlockUid): BlockUid[] =>
  db.select<{ uid: BlockUid }>(
    `WITH RECURSIVE chain(uid, parent_uid, path) AS (
       SELECT uid, parent_uid, ',' || uid || ',' FROM blocks WHERE uid = ?
       UNION ALL
       SELECT b.uid, b.parent_uid, c.path || b.uid || ','
         FROM chain c JOIN blocks b ON b.uid = c.parent_uid
        WHERE instr(c.path, ',' || b.uid || ',') = 0
     )
     SELECT uid FROM chain`, [uid]).map((r) => r.uid);

export const subtreeUids = (db: ReplicaDb, uid: BlockUid): BlockUid[] =>
  db.select<{ uid: BlockUid }>(
    `WITH RECURSIVE sub(uid, path, depth) AS (
       SELECT uid, ',' || uid || ',', 0 FROM blocks WHERE uid = ?
       UNION ALL
       SELECT b.uid, s.path || b.uid || ',', s.depth + 1
         FROM sub s JOIN blocks b ON b.parent_uid = s.uid
        WHERE instr(s.path, ',' || b.uid || ',') = 0
     )
     SELECT uid FROM sub ORDER BY depth DESC`, [uid]).map((r) => r.uid);

/** The facts placementFor reads for a create or move. */
const placementFacts = (db: ReplicaDb, op: CreateOp | MoveOp,
                        block: BlockInfo | null): PlacementFacts => {
  const parentUid = op.parent_uid ?? null;
  const parent = parentUid !== null ? blockInfo(db, parentUid) : null;
  return {
    block,
    parent,
    parentChain: op.op === "move" && block !== null && parent !== null
      ? parentChain(db, parentUid!) : [],
    titlePageId: op.op === "move" && parentUid === null && op.page_title != null
      ? existingLocalPageId(db, op.page_title) : null,
  };
};

/** Carry out placementFor's verdict for a create or move. */
const place = (db: ReplicaDb, op: CreateOp | MoveOp, block: BlockInfo | null,
               verdict: Placement, nowMs: number): void => {
  if (verdict.kind === "skip") return;
  if (verdict.kind === "keep") {
    // only a replayed create is ever kept with a re-page
    const at = block!;
    if (verdict.repageTo !== null) {
      for (const uid of subtreeUids(db, op.uid)) {
        db.exec("UPDATE blocks SET page_id = ? WHERE uid = ?",
                [verdict.repageTo, uid]);
      }
      at.page_id = verdict.repageTo;
    }
    keepSlot(db, op.uid, at);
    return;
  }
  const pageId = "id" in verdict.page
    ? verdict.page.id
    : getOrCreateLocalPage(db, verdict.page.title, nowMs);
  shiftSiblings(db, pageId, verdict.parentUid, verdict.orderIdx);
  if (op.op === "create") {
    db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at, view_type)" +
      " VALUES (?,?,?,?,?,?,0,?,?,?)",
      [op.uid, pageId, verdict.parentUid, verdict.orderIdx, op.text,
       op.heading ?? null, nowMs, nowMs, op.view_type ?? null]);
    reindexRefs(db, op.uid, op.text, nowMs);
    touchPage(db, pageId, nowMs);
    return;
  }
  // past the skip check, a move names an existing block
  const moved = block!;
  db.exec(
    "UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = ?" +
    " WHERE uid = ?",
    [verdict.parentUid, verdict.orderIdx, nowMs, op.uid]);
  if (verdict.repage) {
    for (const uid of subtreeUids(db, op.uid)) {
      db.exec("UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
              [pageId, nowMs, uid]);
    }
    touchPage(db, moved.page_id, nowMs);
  }
  touchPage(db, pageId, nowMs);
};

function applyOne(db: ReplicaDb, op: BlockOp, nowMs: number,
                  reapply: boolean): void {
  if (op.op === "create_page") {
    getOrCreateLocalPage(db, op.page_title, nowMs);
    return;
  }
  const info = blockInfo(db, op.uid);
  if (op.op === "create" || op.op === "move") {
    place(db, op, info,
          placementFor(op, placementFacts(db, op, info), reapply), nowMs);
    return;
  }
  if (skipsOnMissingTarget(op, info !== null, false)) return;

  switch (op.op) {
    case "update_text": {
      // past the skip check, every op but create names an existing block
      const block = info!;
      db.exec("UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
              [op.text, nowMs, op.uid]);
      reindexRefs(db, op.uid, op.text, nowMs);
      touchPage(db, block.page_id, nowMs);
      return;
    }
    case "delete": {
      const block = info!;
      for (const uid of subtreeUids(db, op.uid)) {
        db.exec("DELETE FROM blocks WHERE uid = ?", [uid]);
      }
      touchPage(db, block.page_id, nowMs);
      return;
    }
    case "set_collapsed": {
      // Collapse/expand is not a real change: unlike the
      // other cases here, it must not bump the block's updated_at or its
      // page's — otherwise a UI-only toggle would pollute "last changed"
      // and reorder recency-sorted page lists.
      db.exec("UPDATE blocks SET collapsed = ? WHERE uid = ?",
              [op.collapsed ? 1 : 0, op.uid]);
      return;
    }
    case "set_heading": {
      const block = info!;
      db.exec("UPDATE blocks SET heading = ?, updated_at = ? WHERE uid = ?",
              [op.heading ?? null, nowMs, op.uid]);
      touchPage(db, block.page_id, nowMs);
      return;
    }
    case "set_view_type": {
      const block = info!;
      db.exec("UPDATE blocks SET view_type = ?, updated_at = ? WHERE uid = ?",
              [op.view_type, nowMs, op.uid]);
      touchPage(db, block.page_id, nowMs);
      return;
    }
  }
}

/** Apply a batch atomically; a throwing op rolls the whole batch back.
 * An op on a missing target, or a move that would make a cycle, is skipped
 * rather than thrown on, as the server skips it, so the rest of the batch
 * still lands (the replica may simply be behind the editor). What still throws: a create onto an existing uid, a
 * title the grammar refuses. Callers treat the local apply as best-effort
 * cache maintenance, never as durability.
 *
 * `reapply` is reapplyPending's replay of a batch already applied once: a
 * create whose uid exists and a move whose block already sits at its target
 * are kept in place (keepSlot) instead of failing or shifting again. */
export function applyLocalOps(db: ReplicaDb, ops: BlockOp[], nowMs: number,
                              { reapply = false }: { reapply?: boolean } = {},
): void {
  const violation = findOpTitleViolation(ops);
  if (violation !== null) throw titleViolationError(violation);
  db.transaction(() => {
    for (const op of ops) applyOne(db, op, nowMs, reapply);
  });
}
