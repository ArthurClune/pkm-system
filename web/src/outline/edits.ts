// pattern: Functional Core
// Outline edit commands: each gesture becomes the exact server op batch, the
// tree after applying it (via applyOps — the ops ARE the local mutation, so
// optimistic state can't diverge from what the server will do), and where
// focus lands. MoveOp.order_idx is "insert before the block currently at
// order_idx, counted BEFORE the moved block is removed" (plan-3 contract
// note) — order_idx values are always read off the tree, never array
// positions, because the server leaves gaps.
import type { BlockNode } from "../api/payloads";
import type { BlockOp, SetViewTypeOp } from "../api/ops";
import { applyOps, findNode, locate, selectionRoots,
         visibleNeighbor } from "./tree";

export interface FocusTarget {
  uid: string;
  cursor: number;
}

/** Where the caret should land after adopting new text at a prior offset:
 * keep the offset, clamped to the (possibly shorter) new length. */
export function clampCaret(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length));
}

export interface EditResult {
  blocks: BlockNode[];
  ops: BlockOp[];
  focus: FocusTarget | null; // null = leave focus where it is
}

function noop(blocks: BlockNode[]): EditResult {
  return { blocks, ops: [], focus: null };
}

function done(blocks: BlockNode[], pageTitle: string, ops: BlockOp[],
              focus: FocusTarget | null): EditResult {
  return { blocks: applyOps(blocks, ops, pageTitle), ops, focus };
}

/** order_idx that inserts immediately after siblings[index]: the next
 * sibling's order_idx (insert before it), or last + 1. */
function idxAfter(siblings: BlockNode[], index: number): number {
  const next = siblings[index + 1];
  return next ? next.order_idx : siblings[index].order_idx + 1;
}

export function splitBlock(blocks: BlockNode[], pageTitle: string, uid: string,
                           cursor: number, newUid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found) return noop(blocks);
  const { node, parent, siblings, index } = found;
  if (cursor === 0 && node.text !== "") {
    // Enter at the start: push the block down by inserting an empty sibling
    // ABOVE — the existing uid keeps its text (and any ((uid)) refs to it).
    const ops: BlockOp[] = [{ op: "create", uid: newUid, page_title: pageTitle,
                              parent_uid: parent?.uid ?? null,
                              order_idx: node.order_idx, text: "" }];
    return done(blocks, pageTitle, ops, { uid, cursor: 0 });
  }
  const before = node.text.slice(0, cursor);
  const after = node.text.slice(cursor);
  const ops: BlockOp[] = [];
  if (after !== "") ops.push({ op: "update_text", uid, text: before });
  const intoChildren = node.children.length > 0 && !node.collapsed;
  ops.push({
    op: "create", uid: newUid, page_title: pageTitle,
    parent_uid: intoChildren ? uid : parent?.uid ?? null,
    order_idx: intoChildren ? node.children[0].order_idx
                            : idxAfter(siblings, index),
    text: after,
  });
  return done(blocks, pageTitle, ops, { uid: newUid, cursor: 0 });
}

export function indentBlock(blocks: BlockNode[], pageTitle: string,
                            uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.index === 0) return noop(blocks);
  const prev = found.siblings[found.index - 1];
  const last = prev.children[prev.children.length - 1];
  const ops: BlockOp[] = [];
  if (prev.collapsed) {
    ops.push({ op: "set_collapsed", uid: prev.uid, collapsed: false });
  }
  ops.push({ op: "move", uid, parent_uid: prev.uid,
             order_idx: last ? last.order_idx + 1 : 0 });
  return done(blocks, pageTitle, ops, null);
}

export function outdentBlock(blocks: BlockNode[], pageTitle: string,
                             uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.parent === null) return noop(blocks);
  const parentLoc = locate(blocks, found.parent.uid);
  if (!parentLoc) return noop(blocks);
  const ops: BlockOp[] = [{
    op: "move", uid, parent_uid: parentLoc.parent?.uid ?? null,
    order_idx: idxAfter(parentLoc.siblings, parentLoc.index),
  }];
  return done(blocks, pageTitle, ops, null);
}

export function moveBlockUp(blocks: BlockNode[], pageTitle: string,
                            uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.index === 0) return noop(blocks);
  const prev = found.siblings[found.index - 1];
  const ops: BlockOp[] = [{ op: "move", uid,
                            parent_uid: found.parent?.uid ?? null,
                            order_idx: prev.order_idx }];
  return done(blocks, pageTitle, ops, null);
}

export function moveBlockDown(blocks: BlockNode[], pageTitle: string,
                              uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.index === found.siblings.length - 1) return noop(blocks);
  const ops: BlockOp[] = [{ op: "move", uid,
                            parent_uid: found.parent?.uid ?? null,
                            order_idx: idxAfter(found.siblings, found.index + 1) }];
  return done(blocks, pageTitle, ops, null);
}

/** Depth-preserving move that can cross a parent boundary (pkm-hx2w): a
 * previous sibling is a plain swap (delegates to moveBlockUp); otherwise, if
 * the parent has a previous sibling P, the block becomes P's LAST child —
 * same absolute depth, now inside the preceding subtree. No further escape:
 * if P doesn't exist (top-level, or parent is itself a first child), it's a
 * no-op rather than letting the block become shallower. A collapsed P is
 * expanded first (mirrors indentBlock) — otherwise the moved block would be
 * hidden and, since it stays focused, focus would be lost with it. */
export function moveSubtreeUp(blocks: BlockNode[], pageTitle: string,
                              uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found) return noop(blocks);
  if (found.index > 0) return moveBlockUp(blocks, pageTitle, uid);
  if (!found.parent) return noop(blocks);
  const parentLoc = locate(blocks, found.parent.uid);
  if (!parentLoc || parentLoc.index === 0) return noop(blocks);
  const p = parentLoc.siblings[parentLoc.index - 1];
  const last = p.children[p.children.length - 1];
  const ops: BlockOp[] = [];
  if (p.collapsed) {
    ops.push({ op: "set_collapsed", uid: p.uid, collapsed: false });
  }
  ops.push({ op: "move", uid, parent_uid: p.uid,
             order_idx: last ? last.order_idx + 1 : 0 });
  return done(blocks, pageTitle, ops, null);
}

/** Mirror of moveSubtreeUp: a next sibling is a plain swap (delegates to
 * moveBlockDown); otherwise the block becomes the FIRST child of the
 * parent's next sibling N, same depth. No-op when N doesn't exist. A
 * collapsed N is expanded first, for the same reason as moveSubtreeUp's P. */
export function moveSubtreeDown(blocks: BlockNode[], pageTitle: string,
                                uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found) return noop(blocks);
  if (found.index < found.siblings.length - 1) return moveBlockDown(blocks, pageTitle, uid);
  if (!found.parent) return noop(blocks);
  const parentLoc = locate(blocks, found.parent.uid);
  if (!parentLoc || parentLoc.index === parentLoc.siblings.length - 1) return noop(blocks);
  const n = parentLoc.siblings[parentLoc.index + 1];
  const ops: BlockOp[] = [];
  if (n.collapsed) {
    ops.push({ op: "set_collapsed", uid: n.uid, collapsed: false });
  }
  ops.push({ op: "move", uid, parent_uid: n.uid,
             order_idx: n.children[0]?.order_idx ?? 0 });
  return done(blocks, pageTitle, ops, null);
}

/** Locate uids as a single contiguous run of siblings — same parent,
 * consecutive positions, in the given order. Null when they aren't (a
 * multi-block selection can span parent/child levels; only a plain sibling
 * run has an unambiguous "move as a group" meaning, matching the single-block
 * moveBlockUp/moveBlockDown's own same-parent restriction). */
function locateSiblingRun(blocks: BlockNode[], uids: string[]):
    { parent: BlockNode | null; siblings: BlockNode[]; first: number; last: number }
    | null {
  if (uids.length === 0) return null;
  const head = locate(blocks, uids[0]);
  if (!head) return null;
  const { parent, siblings, index: first } = head;
  for (let k = 1; k < uids.length; k++) {
    const found = locate(blocks, uids[k]);
    if (!found || found.siblings !== siblings || found.index !== first + k) {
      return null;
    }
  }
  return { parent, siblings, first, last: first + uids.length - 1 };
}

/** Move a contiguous run of selected sibling blocks up as a group: the
 * sibling directly above hops to the far side of the run instead, so none of
 * the selected blocks move relative to each other (or need their own move
 * op). No-op when the uids aren't a plain sibling run, or already at the top. */
export function moveSelectionUp(blocks: BlockNode[], pageTitle: string,
                                uids: string[]): EditResult {
  const run = locateSiblingRun(blocks, uids);
  if (!run || run.first === 0) return noop(blocks);
  const prev = run.siblings[run.first - 1];
  const ops: BlockOp[] = [{ op: "move", uid: prev.uid,
                            parent_uid: run.parent?.uid ?? null,
                            order_idx: idxAfter(run.siblings, run.last) }];
  return done(blocks, pageTitle, ops, null);
}

/** Mirror of moveSelectionUp: the sibling directly below hops in front of
 * the run. */
export function moveSelectionDown(blocks: BlockNode[], pageTitle: string,
                                  uids: string[]): EditResult {
  const run = locateSiblingRun(blocks, uids);
  if (!run || run.last === run.siblings.length - 1) return noop(blocks);
  const next = run.siblings[run.last + 1];
  const ops: BlockOp[] = [{ op: "move", uid: next.uid,
                            parent_uid: run.parent?.uid ?? null,
                            order_idx: run.siblings[run.first].order_idx }];
  return done(blocks, pageTitle, ops, null);
}

/** The op batch that moves `uids` (pre-reduced to selection roots, document
 * order) to consecutive slots starting at orderIdx under parentUid. Each op's
 * order_idx is one past the previous: applying them in sequence (client
 * applyOps and server ops_apply share the semantics) shifts non-group
 * siblings right while already-placed group members stay put, so the run
 * lands contiguously in its original order. */
export function groupMoveOps(uids: string[], parentUid: string | null,
                             orderIdx: number): BlockOp[] {
  return uids.map((uid, k) => (
    { op: "move", uid, parent_uid: parentUid, order_idx: orderIdx + k }));
}

/** Move every listed block (a multi-block selection) to the drop target as
 * one contiguous run, preserving their relative order. Only selection roots
 * get a move op — a selected descendant travels inside its parent's subtree. */
export function moveBlocksTo(blocks: BlockNode[], pageTitle: string,
                             uids: string[], parentUid: string | null,
                             orderIdx: number): EditResult {
  const roots = selectionRoots(blocks, uids);
  if (roots.length === 0) return noop(blocks);
  return done(blocks, pageTitle, groupMoveOps(roots, parentUid, orderIdx), null);
}

/** Delete every selected block. Only "root" uids — those with no ancestor
 * also in the selection — get an explicit delete op: deleting a block already
 * removes its whole subtree (see tree.ts applyOne), so a selected descendant
 * is cascaded away for free. Focus falls back to the visible block just
 * before the run, then the sibling right after the last deleted root, else
 * null (nothing left to focus). */
export function deleteSelection(blocks: BlockNode[], pageTitle: string,
                                uids: string[]): EditResult {
  const roots = selectionRoots(blocks, uids);
  if (roots.length === 0) return noop(blocks);
  const ops: BlockOp[] = roots.map((uid) => ({ op: "delete", uid }));
  const before = visibleNeighbor(blocks, uids[0], "up");
  const lastRoot = locate(blocks, roots[roots.length - 1]);
  const after = lastRoot?.siblings[lastRoot.index + 1]?.uid ?? null;
  const focus =
    before ? { uid: before, cursor: findNode(blocks, before)?.text.length ?? 0 }
    : after ? { uid: after, cursor: 0 }
    : null;
  return done(blocks, pageTitle, ops, focus);
}

export function backspaceAtStart(blocks: BlockNode[], pageTitle: string,
                                 uid: string): EditResult {
  const found = locate(blocks, uid);
  if (!found || found.node.children.length > 0) return noop(blocks);
  if (found.index === 0) {
    // No previous sibling to merge into, but an emptied block must still be
    // deletable: focus the parent (the block visually above), or the next
    // sibling when this is the first top-level block. focus null (sole block
    // on the page) leaves focus on the unmounting textarea, whose blur
    // clears it.
    if (found.node.text !== "") return noop(blocks);
    const next = found.siblings[1];
    const focus = found.parent
      ? { uid: found.parent.uid, cursor: found.parent.text.length }
      : next ? { uid: next.uid, cursor: 0 } : null;
    return done(blocks, pageTitle, [{ op: "delete", uid }], focus);
  }
  const prev = found.siblings[found.index - 1];
  if (prev.children.length > 0) {
    // Merging into a structured block is ambiguous; only delete-if-empty,
    // landing focus on the block that visually precedes the deleted one.
    if (found.node.text !== "") return noop(blocks);
    let target = prev;
    while (!target.collapsed && target.children.length > 0) {
      target = target.children[target.children.length - 1];
    }
    return done(blocks, pageTitle, [{ op: "delete", uid }],
                { uid: target.uid, cursor: target.text.length });
  }
  const ops: BlockOp[] = [
    { op: "update_text", uid: prev.uid, text: prev.text + found.node.text },
    { op: "delete", uid },
  ];
  return done(blocks, pageTitle, ops,
              { uid: prev.uid, cursor: prev.text.length });
}

export function setCollapsed(blocks: BlockNode[], pageTitle: string,
                             uid: string, collapsed: boolean): EditResult {
  if (!findNode(blocks, uid)) return noop(blocks);
  return done(blocks, pageTitle,
              [{ op: "set_collapsed", uid, collapsed }], null);
}

export function setHeading(blocks: BlockNode[], pageTitle: string,
                           uid: string, heading: number | null): EditResult {
  if (!findNode(blocks, uid)) return noop(blocks);
  return done(blocks, pageTitle, [{ op: "set_heading", uid, heading }], null);
}

export function setViewType(blocks: BlockNode[], pageTitle: string,
                            uid: string,
                            viewType: SetViewTypeOp["view_type"]): EditResult {
  if (!findNode(blocks, uid)) return noop(blocks);
  return done(blocks, pageTitle,
              [{ op: "set_view_type", uid, view_type: viewType }], null);
}
