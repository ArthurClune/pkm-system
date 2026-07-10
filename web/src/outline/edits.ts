// pattern: Functional Core
// Outline edit commands: each gesture becomes the exact server op batch, the
// tree after applying it (via applyOps — the ops ARE the local mutation, so
// optimistic state can't diverge from what the server will do), and where
// focus lands. MoveOp.order_idx is "insert before the block currently at
// order_idx, counted BEFORE the moved block is removed" (plan-3 contract
// note) — order_idx values are always read off the tree, never array
// positions, because the server leaves gaps.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { applyOps, findNode, locate } from "./tree";

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
