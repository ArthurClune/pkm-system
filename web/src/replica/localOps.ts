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
// a block under itself or its own descendant. A create or move under a
// live parent lands on the parent's page, whatever its page_title says.
// A re-applied batch (reapply) finds its own create and move
// effects already in place and does not repeat them.

import type { BlockOp } from "../api/ops";
import { reindexBlockRefs } from "./blockRefs";
import type { ReplicaDb } from "./db";
import { plainSpaceTitleCanonicalizationActive } from "./meta";
import { skipsOnMissingTarget } from "./missingTarget";
import { canonicalizeTitle, findOpTitleViolation,
         type OpTitleViolation, titleSyntaxReason } from "./titles";

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

export function getOrCreateLocalPage(db: ReplicaDb, title: string,
                                     nowMs: number): number {
  title = canonicalizeTitle(
    title, plainSpaceTitleCanonicalizationActive(db));
  if (title.trim().length === 0) title = "Untitled";
  if (titleSyntaxReason(title) !== null) {
    throw new LocalOpError(`unsupported page title syntax: ${JSON.stringify(title)}`);
  }
  const existing = db.select<{ id: number }>(
    "SELECT id FROM pages WHERE title = ?", [title]);
  if (existing.length > 0) return existing[0].id;
  const next = db.select<{ id: number }>(
    "SELECT MIN(0, COALESCE((SELECT MIN(id) FROM pages), 0)) - 1 AS id")[0].id;
  db.exec(
    "INSERT INTO pages(id, title, created_at, updated_at) VALUES (?,?,?,?)",
    [next, title, nowMs, nowMs]);
  return next;
}

const reindexRefs = (db: ReplicaDb, uid: string, text: string,
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

const touchPage = (db: ReplicaDb, pageId: number, nowMs: number): void => {
  db.exec("UPDATE pages SET updated_at = ? WHERE id = ?", [nowMs, pageId]);
};

const shiftSiblings = (db: ReplicaDb, pageId: number,
                       parentUid: string | null, fromIdx: number): void => {
  db.exec(
    "UPDATE blocks SET order_idx = order_idx + 1" +
    " WHERE page_id = ? AND parent_uid IS ? AND order_idx >= ?",
    [pageId, parentUid, fromIdx]);
};

interface BlockInfo {
  page_id: number; parent_uid: string | null; order_idx: number;
}

const blockInfo = (db: ReplicaDb, uid: string): BlockInfo | null => {
  const rows = db.select<BlockInfo>(
    "SELECT page_id, parent_uid, order_idx FROM blocks WHERE uid = ?", [uid]);
  return rows.length > 0 ? rows[0] : null;
};

/** Replay of a create or move already in place: shifting again would drift
 * every later sibling's order_idx on each feed window, until a sibling the
 * feed re-ships at its server index overtakes one that drifted. Shift only
 * when a sibling the window re-shipped now shares this block's slot. */
const keepSlot = (db: ReplicaDb, uid: string, at: BlockInfo): void => {
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
const parentChain = (db: ReplicaDb, uid: string): string[] =>
  db.select<{ uid: string }>(
    `WITH RECURSIVE chain(uid, parent_uid, path) AS (
       SELECT uid, parent_uid, ',' || uid || ',' FROM blocks WHERE uid = ?
       UNION ALL
       SELECT b.uid, b.parent_uid, c.path || b.uid || ','
         FROM chain c JOIN blocks b ON b.uid = c.parent_uid
        WHERE instr(c.path, ',' || b.uid || ',') = 0
     )
     SELECT uid FROM chain`, [uid]).map((r) => r.uid);

export const subtreeUids = (db: ReplicaDb, uid: string): string[] =>
  db.select<{ uid: string }>(
    `WITH RECURSIVE sub(uid, path, depth) AS (
       SELECT uid, ',' || uid || ',', 0 FROM blocks WHERE uid = ?
       UNION ALL
       SELECT b.uid, s.path || b.uid || ',', s.depth + 1
         FROM sub s JOIN blocks b ON b.parent_uid = s.uid
        WHERE instr(s.path, ',' || b.uid || ',') = 0
     )
     SELECT uid FROM sub ORDER BY depth DESC`, [uid]).map((r) => r.uid);

function applyOne(db: ReplicaDb, op: BlockOp, nowMs: number,
                  reapply: boolean): void {
  if (op.op === "create_page") {
    getOrCreateLocalPage(db, op.page_title, nowMs);
    return;
  }
  const info = blockInfo(db, op.uid);
  const parentUid = op.op === "create" || op.op === "move"
    ? op.parent_uid ?? null : null;
  const parentInfo = parentUid !== null ? blockInfo(db, parentUid) : null;
  const chain = op.op === "move" && info !== null && parentInfo !== null
    ? parentChain(db, parentUid!) : [];
  if (skipsOnMissingTarget(op, info !== null, parentInfo !== null, chain)) {
    return;
  }

  switch (op.op) {
    case "create": {
      // On replay the row is this create's own: the enqueue-time apply, or
      // the server's echo. Later ops re-apply over it; keep it as it is.
      if (reapply && info !== null) {
        // ... except that it follows a parent the window moved to another
        // page, as the server will place it. Only while it is
        // still under that parent: a later pending move that took it
        // elsewhere owns its page, and re-paging it here would make that
        // move's replay re-shift its target's children on every window.
        if (parentInfo !== null
            && info.parent_uid === (op.parent_uid ?? null)
            && info.page_id !== parentInfo.page_id) {
          for (const uid of subtreeUids(db, op.uid)) {
            db.exec("UPDATE blocks SET page_id = ? WHERE uid = ?",
                    [parentInfo.page_id, uid]);
          }
          info.page_id = parentInfo.page_id;
        }
        keepSlot(db, op.uid, info);
        return;
      }
      // otherwise an existing uid fails the INSERT, as the server 400s.
      // Under a live parent the block lands on the parent's page, as on
      // the server: page_title places only a top-level create.
      const pageId = parentInfo !== null
        ? parentInfo.page_id
        : getOrCreateLocalPage(db, op.page_title, nowMs);
      shiftSiblings(db, pageId, op.parent_uid ?? null, op.order_idx);
      db.exec(
        "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text," +
        " heading, collapsed, created_at, updated_at, view_type)" +
        " VALUES (?,?,?,?,?,?,0,?,?,?)",
        [op.uid, pageId, op.parent_uid ?? null, op.order_idx, op.text,
         op.heading ?? null, nowMs, nowMs, op.view_type ?? null]);
      reindexRefs(db, op.uid, op.text, nowMs);
      touchPage(db, pageId, nowMs);
      return;
    }
    case "update_text": {
      // past the skip check, every op but create names an existing block
      const block = info!;
      db.exec("UPDATE blocks SET text = ?, updated_at = ? WHERE uid = ?",
              [op.text, nowMs, op.uid]);
      reindexRefs(db, op.uid, op.text, nowMs);
      touchPage(db, block.page_id, nowMs);
      return;
    }
    case "move": {
      const block = info!;
      const parent = op.parent_uid !== null ? parentInfo! : null;
      const targetPage = parent !== null
        ? parent.page_id
        : (op.page_title != null
           ? getOrCreateLocalPage(db, op.page_title, nowMs)
           : block.page_id);
      if (reapply && block.page_id === targetPage
          && block.parent_uid === (op.parent_uid ?? null)
          && block.order_idx === op.order_idx) {
        keepSlot(db, op.uid, block);
        return;
      }
      shiftSiblings(db, targetPage, op.parent_uid ?? null, op.order_idx);
      db.exec(
        "UPDATE blocks SET parent_uid = ?, order_idx = ?, updated_at = ?" +
        " WHERE uid = ?",
        [op.parent_uid ?? null, op.order_idx, nowMs, op.uid]);
      if (targetPage !== block.page_id) {
        for (const uid of subtreeUids(db, op.uid)) {
          db.exec("UPDATE blocks SET page_id = ?, updated_at = ? WHERE uid = ?",
                  [targetPage, nowMs, uid]);
        }
        touchPage(db, block.page_id, nowMs);
      }
      touchPage(db, targetPage, nowMs);
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
