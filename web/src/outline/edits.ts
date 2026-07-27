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

type MoveDirection = "up" | "down";

interface CrossParentDestination {
  parentUid: string;
  orderIdx: number;
  expandUid: string | null;
}

/** At a sibling-list edge, preserve absolute depth by moving into the
 * previous/next sibling of the current parent. */
function crossParentDestination(
  blocks: BlockNode[],
  parent: BlockNode | null,
  direction: MoveDirection,
): CrossParentDestination | null {
  if (!parent) return null;
  const parentLoc = locate(blocks, parent.uid);
  if (!parentLoc) return null;
  const targetIndex = direction === "up"
    ? parentLoc.index - 1
    : parentLoc.index + 1;
  const target = parentLoc.siblings[targetIndex];
  if (!target) return null;
  const orderIdx = direction === "up"
    ? (target.children[target.children.length - 1]?.order_idx ?? -1) + 1
    : target.children[0]?.order_idx ?? 0;
  return {
    parentUid: target.uid,
    orderIdx,
    expandUid: target.collapsed ? target.uid : null,
  };
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

interface SelectionSiblingRun {
  uids: string[];
  parent: BlockNode | null;
  siblings: BlockNode[];
  first: number;
}

/** Reduce selected descendants to roots, then group consecutive roots that
 * shared a parent in the original tree. All destinations are derived from
 * these original runs before any move is applied. */
function selectionSiblingRuns(blocks: BlockNode[], uids: string[]):
    SelectionSiblingRun[] | null {
  if (uids.length === 0) return [];
  if (uids.some((uid) => !locate(blocks, uid))) return null;
  const runs: SelectionSiblingRun[] = [];
  for (const uid of selectionRoots(blocks, uids)) {
    const found = locate(blocks, uid);
    if (!found) return null;
    const last = runs[runs.length - 1];
    if (last && last.siblings === found.siblings
        && found.index === last.first + last.uids.length) {
      last.uids.push(uid);
    } else {
      runs.push({
        uids: [uid], parent: found.parent,
        siblings: found.siblings, first: found.index,
      });
    }
  }
  return runs;
}

/** Indent every selected root exactly once. Complete preflight precedes op
 * generation, so one first-sibling run aborts the whole gesture and selected
 * siblings can never become one another's parent. */
export function indentSelection(blocks: BlockNode[], pageTitle: string,
                                uids: string[]): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0 || runs.some((run) => run.first === 0)) {
    return noop(blocks);
  }
  const ops: BlockOp[] = [];
  for (const run of runs) {
    const target = run.siblings[run.first - 1];
    const lastChild = target.children[target.children.length - 1];
    if (target.collapsed) {
      ops.push({ op: "set_collapsed", uid: target.uid, collapsed: false });
    }
    ops.push(...groupMoveOps(
      run.uids, target.uid, lastChild ? lastChild.order_idx + 1 : 0,
    ));
  }
  return done(blocks, pageTitle, ops, null);
}

/** Outdent every selected root exactly once. A top-level run aborts the whole
 * gesture; otherwise each run lands consecutively after its former parent. */
export function outdentSelection(blocks: BlockNode[], pageTitle: string,
                                 uids: string[]): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0
      || runs.some((run) => run.parent === null)) {
    return noop(blocks);
  }
  const plans: Array<{
    uids: string[];
    parentUid: string | null;
    orderIdx: number;
  }> = [];
  for (const run of runs) {
    if (!run.parent) return noop(blocks);
    const parentLoc = locate(blocks, run.parent.uid);
    if (!parentLoc) return noop(blocks);
    plans.push({
      uids: run.uids,
      parentUid: parentLoc.parent?.uid ?? null,
      orderIdx: idxAfter(parentLoc.siblings, parentLoc.index),
    });
  }
  const ops = plans.flatMap((plan) =>
    groupMoveOps(plan.uids, plan.parentUid, plan.orderIdx));
  return done(blocks, pageTitle, ops, null);
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
  const destination = crossParentDestination(blocks, found.parent, "up");
  if (!destination) return noop(blocks);
  const ops: BlockOp[] = [];
  if (destination.expandUid) {
    ops.push({
      op: "set_collapsed", uid: destination.expandUid, collapsed: false,
    });
  }
  ops.push({
    op: "move", uid, parent_uid: destination.parentUid,
    order_idx: destination.orderIdx,
  });
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
  if (found.index < found.siblings.length - 1) {
    return moveBlockDown(blocks, pageTitle, uid);
  }
  const destination = crossParentDestination(blocks, found.parent, "down");
  if (!destination) return noop(blocks);
  const ops: BlockOp[] = [];
  if (destination.expandUid) {
    ops.push({
      op: "set_collapsed", uid: destination.expandUid, collapsed: false,
    });
  }
  ops.push({
    op: "move", uid, parent_uid: destination.parentUid,
    order_idx: destination.orderIdx,
  });
  return done(blocks, pageTitle, ops, null);
}

interface SelectionRunMovePlan {
  expandUid: string | null;
  ops: BlockOp[];
}

function planSelectionRunMove(
  blocks: BlockNode[],
  run: SelectionSiblingRun,
  direction: MoveDirection,
): SelectionRunMovePlan | null {
  const last = run.first + run.uids.length - 1;
  if (direction === "up" && run.first > 0) {
    const previous = run.siblings[run.first - 1];
    return {
      expandUid: null,
      ops: [{
        op: "move", uid: previous.uid,
        parent_uid: run.parent?.uid ?? null,
        order_idx: idxAfter(run.siblings, last),
      }],
    };
  }
  if (direction === "down" && last < run.siblings.length - 1) {
    const next = run.siblings[last + 1];
    return {
      expandUid: null,
      ops: [{
        op: "move", uid: next.uid,
        parent_uid: run.parent?.uid ?? null,
        order_idx: run.siblings[run.first].order_idx,
      }],
    };
  }
  const destination = crossParentDestination(
    blocks, run.parent, direction,
  );
  if (!destination) return null;
  return {
    expandUid: destination.expandUid,
    ops: groupMoveOps(
      run.uids, destination.parentUid, destination.orderIdx,
    ),
  };
}

function moveSelection(
  blocks: BlockNode[],
  pageTitle: string,
  uids: string[],
  direction: MoveDirection,
): EditResult {
  const runs = selectionSiblingRuns(blocks, uids);
  if (!runs || runs.length === 0) return noop(blocks);
  const plans: SelectionRunMovePlan[] = [];
  for (const run of runs) {
    const plan = planSelectionRunMove(blocks, run, direction);
    if (!plan) return noop(blocks);
    plans.push(plan);
  }

  const selectedRoots = new Set(runs.flatMap((run) => run.uids));
  const expanded = new Set<string>();
  const ops: BlockOp[] = [];
  for (const plan of plans) {
    if (plan.expandUid
        && !selectedRoots.has(plan.expandUid)
        && !expanded.has(plan.expandUid)) {
      ops.push({
        op: "set_collapsed", uid: plan.expandUid, collapsed: false,
      });
      expanded.add(plan.expandUid);
    }
    ops.push(...plan.ops);
  }
  return done(blocks, pageTitle, ops, null);
}

export function moveSelectionUp(blocks: BlockNode[], pageTitle: string,
                                uids: string[]): EditResult {
  return moveSelection(blocks, pageTitle, uids, "up");
}

export function moveSelectionDown(blocks: BlockNode[], pageTitle: string,
                                  uids: string[]): EditResult {
  return moveSelection(blocks, pageTitle, uids, "down");
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
