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
// lands is placementFor's verdict (placement.ts); this file runs it.
// Every write is preceded by a call recording the row's pre-image under the
// op's batch (replayLog.ts), so a feed window can rewind the batch and
// replay it as a first apply.

import type { BatchId, BlockUid, OrderIdx, PageId } from "../api/brands";
import type { BlockOp, CreateOp, MoveOp } from "../api/ops";
import { reindexBlockRefs } from "./blockRefs";
import type { ReplicaDb } from "./db";
import { skipsOnMissingTarget } from "./missingTarget";
import { existingLocalPageId, localPageTitle, pageIdByTitle } from "./pageLookup";
import { type Placement, type PlacementFacts, placementFor } from "./placement";
import { recordBlocks, recordPage, recordSiblingsFrom } from "./replayLog";
import type { FreedPages } from "./rewind";
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

/** The batch a page mint is recorded under, and the ids a window's rewind
 * freed by title. */
type MintRecord = { batchId: BatchId; freed?: FreedPages };

/** The page titled `requested`, minted with a negative id when none holds
 * the title. With `record`, a mint is recorded under that batch and reuses
 * the id the rewind freed for the title, while it is still free, so a
 * replay does not churn local page ids (backlinks group by page_id). Reads
 * that mint a daily page pass none: no op is behind that page. */
export function getOrCreateLocalPage(db: ReplicaDb, requested: string,
                                     nowMs: number, record?: MintRecord): PageId {
  const title = localPageTitle(db, requested);
  if (titleSyntaxReason(title) !== null) {
    throw new LocalOpError(`unsupported page title syntax: ${JSON.stringify(title)}`);
  }
  const existing = pageIdByTitle(db, title);
  if (existing !== null) return existing;
  const reuse = record?.freed?.get(title);
  const next = reuse !== undefined
      && db.select("SELECT 1 AS x FROM pages WHERE id = ?", [reuse]).length === 0
    ? reuse
    : db.select<{ id: PageId }>(
        "SELECT MIN(0, COALESCE((SELECT MIN(id) FROM pages), 0)) - 1 AS id")[0].id;
  if (record !== undefined) recordPage(db, record.batchId, next, true);
  db.exec(
    "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
    [next, title, nowMs, nowMs]);
  return next;
}

const reindexRefs = (db: ReplicaDb, uid: BlockUid, text: string,
                     nowMs: number, record: MintRecord): void => {
  // The block-level index is the composition apply.ts
  // shares; it hands back the parse so the page-level refs below reuse it.
  const { refs } = reindexBlockRefs(db, uid, text);
  db.exec("DELETE FROM refs WHERE src_block_uid = ?", [uid]);
  for (const ref of refs) {
    const pageId = getOrCreateLocalPage(db, ref.title, nowMs, record);
    db.exec("INSERT OR IGNORE INTO refs VALUES (?,?,?)",
            [uid, pageId, ref.kind]);
  }
};

/** A replay stamps with the batch's enqueue time, which can be older than an
 * edit another device made since, so a page keeps the later of the two.
 * Every blocks.page_id write must be followed by a call here: it records the
 * page, and that record is the only view the replay's FK pre-check
 * (targetedFkHit) has of any block's page_id. */
const touchPage = (db: ReplicaDb, pageId: PageId, nowMs: number,
                   batchId: BatchId): void => {
  recordPage(db, batchId, pageId, false);
  db.exec("UPDATE pages SET updated_at = MAX(COALESCE(updated_at, 0), ?)" +
          " WHERE id = ?", [nowMs, pageId]);
};

const shiftSiblings = (db: ReplicaDb, pageId: PageId,
                       parentUid: BlockUid | null,
                       fromOrderIdx: OrderIdx, batchId: BatchId): void => {
  recordSiblingsFrom(db, batchId, { pageId, parentUid, fromOrderIdx });
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
               verdict: Placement, nowMs: number, record: MintRecord): void => {
  if (verdict.kind === "skip") return;
  const { batchId } = record;
  const pageId = "id" in verdict.page
    ? verdict.page.id
    : getOrCreateLocalPage(db, verdict.page.title, nowMs, record);
  shiftSiblings(db, pageId, verdict.parentUid, verdict.orderIdx, batchId);
  recordBlocks(db, batchId, [op.uid]);
  if (op.op === "create") {
    db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
      " heading, collapsed, created_at, updated_at, view_type)" +
      " VALUES (?,?,?,?,?,?,0,?,?,?)",
      [op.uid, pageId, verdict.parentUid, verdict.orderIdx, op.text,
       op.heading ?? null, nowMs, nowMs, op.view_type ?? null]);
    reindexRefs(db, op.uid, op.text, nowMs, record);
    touchPage(db, pageId, nowMs, batchId);
    return;
  }
  // past the skip check, a move names an existing block
  const moved = block!;
  db.exec(
    "UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = ?" +
    " WHERE uid = ?",
    [verdict.parentUid, verdict.orderIdx, nowMs, op.uid]);
  if (verdict.repage) {
    const subtree = subtreeUids(db, op.uid);
    recordBlocks(db, batchId, subtree);
    for (const uid of subtree) {
      db.exec("UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
              [pageId, nowMs, uid]);
    }
    touchPage(db, moved.page_id, nowMs, batchId);
  }
  touchPage(db, pageId, nowMs, batchId);
};

function applyOne(db: ReplicaDb, op: BlockOp, nowMs: number,
                  record: MintRecord): void {
  const { batchId } = record;
  if (op.op === "create_page") {
    // recorded even when the page exists, so the stranded-page sweep keeps
    // a page only a pending create_page holds
    const pageId = getOrCreateLocalPage(db, op.page_title, nowMs, record);
    recordPage(db, batchId, pageId, false);
    return;
  }
  const info = blockInfo(db, op.uid);
  if (op.op === "create" || op.op === "move") {
    place(db, op, info, placementFor(op, placementFacts(db, op, info)),
          nowMs, record);
    return;
  }
  if (skipsOnMissingTarget(op, info !== null, false)) return;

  switch (op.op) {
    case "update_text": {
      // past the skip check, every op but create names an existing block
      const block = info!;
      recordBlocks(db, batchId, [op.uid]);
      db.exec("UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
              [op.text, nowMs, op.uid]);
      reindexRefs(db, op.uid, op.text, nowMs, record);
      touchPage(db, block.page_id, nowMs, batchId);
      return;
    }
    case "delete": {
      const block = info!;
      const subtree = subtreeUids(db, op.uid);
      recordBlocks(db, batchId, subtree);
      for (const uid of subtree) {
        db.exec("DELETE FROM blocks WHERE uid = ?", [uid]);
      }
      touchPage(db, block.page_id, nowMs, batchId);
      return;
    }
    case "set_collapsed": {
      // Collapse/expand is not a real change: unlike the
      // other cases here, it must not bump the block's updated_at or its
      // page's — otherwise a UI-only toggle would pollute "last changed"
      // and reorder recency-sorted page lists.
      recordBlocks(db, batchId, [op.uid]);
      db.exec("UPDATE blocks SET collapsed = ? WHERE uid = ?",
              [op.collapsed ? 1 : 0, op.uid]);
      return;
    }
    case "set_heading": {
      const block = info!;
      recordBlocks(db, batchId, [op.uid]);
      db.exec("UPDATE blocks SET heading = ?, updated_at = ? WHERE uid = ?",
              [op.heading ?? null, nowMs, op.uid]);
      touchPage(db, block.page_id, nowMs, batchId);
      return;
    }
    case "set_view_type": {
      const block = info!;
      recordBlocks(db, batchId, [op.uid]);
      db.exec("UPDATE blocks SET view_type = ?, updated_at = ? WHERE uid = ?",
              [op.view_type, nowMs, op.uid]);
      touchPage(db, block.page_id, nowMs, batchId);
      return;
    }
  }
}

/** Apply a batch atomically; a throwing op rolls the whole batch back.
 * An op on a missing target, or a move that would make a cycle, is skipped
 * rather than thrown on, as the server skips it, so the rest of the batch
 * still lands (the replica may simply be behind the editor). What still
 * throws: a create onto an existing uid, a title the grammar refuses.
 * Callers treat the local apply as best-effort cache maintenance, never as
 * durability.
 *
 * Every write is recorded under `batchId` first. `freed` is the ids a
 * window's rewind freed by title, for a replay's mints to reuse. */
export function applyLocalOps(db: ReplicaDb, ops: BlockOp[], nowMs: number,
                              { batchId, freed }:
                                { batchId: BatchId; freed?: FreedPages },
): void {
  const violation = findOpTitleViolation(ops);
  if (violation !== null) throw titleViolationError(violation);
  db.transaction(() => {
    for (const op of ops) applyOne(db, op, nowMs, { batchId, freed });
  });
}
