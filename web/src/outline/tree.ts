// pattern: Functional Core
// Pure helpers over the page block tree: lookup, on-screen order, and
// applying committed op semantics so local state mirrors the server's
// ops_apply.py exactly. ShiftSiblings leaves order_idx gaps on the server;
// everything here keys on order_idx VALUES, never array positions.
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";

export interface Located {
  node: BlockNode;
  parent: BlockNode | null; // null = top-level
  siblings: BlockNode[];    // the array that contains node
  index: number;            // node's position within siblings
}

export function locate(blocks: BlockNode[], uid: string): Located | null {
  const walk = (siblings: BlockNode[], parent: BlockNode | null): Located | null => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i];
      if (node.uid === uid) return { node, parent, siblings, index: i };
      const found = walk(node.children, node);
      if (found) return found;
    }
    return null;
  };
  return walk(blocks, null);
}

export function findNode(blocks: BlockNode[], uid: string): BlockNode | null {
  return locate(blocks, uid)?.node ?? null;
}

/** Depth-first uids in on-screen order; children of collapsed blocks hidden. */
export function visibleUids(blocks: BlockNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: BlockNode[]) => {
    for (const n of nodes) {
      out.push(n.uid);
      if (!n.collapsed) walk(n.children);
    }
  };
  walk(blocks);
  return out;
}

export function visibleNeighbor(blocks: BlockNode[], uid: string,
                                dir: "up" | "down"): string | null {
  const order = visibleUids(blocks);
  const i = order.indexOf(uid);
  if (i < 0) return null;
  return order[dir === "up" ? i - 1 : i + 1] ?? null;
}

function clone(nodes: BlockNode[]): BlockNode[] {
  return nodes.map((n) => ({ ...n, children: clone(n.children) }));
}

function sortSiblings(siblings: BlockNode[]): void {
  siblings.sort((a, b) => a.order_idx - b.order_idx);
}

function siblingsOf(tree: BlockNode[], parentUid: string | null): BlockNode[] | null {
  if (parentUid === null) return tree;
  return locate(tree, parentUid)?.node.children ?? null;
}

/** Mirror of the server's ShiftSiblings effect: everything at or past
 * from_idx moves up one — except the block being moved, whose order_idx is
 * about to be overwritten (matching SetParent-after-ShiftSiblings). */
function shiftFrom(siblings: BlockNode[], fromIdx: number, except?: string): void {
  for (const s of siblings) {
    if (s.uid !== except && s.order_idx >= fromIdx) s.order_idx += 1;
  }
}

/** Apply committed ops to a client tree — the single source of truth for op
 * semantics on the client; both optimistic local edits and remote websocket
 * batches go through here. Ops that don't concern this page are skipped:
 * create is filtered by page_title, everything else by uid presence (the
 * websocket broadcasts ops for ALL pages); create_page never touches a
 * block tree and is always skipped. Returns a new tree. */
export function applyOps(blocks: BlockNode[], ops: BlockOp[],
                         pageTitle: string): BlockNode[] {
  const tree = clone(blocks);
  for (const op of ops) applyOne(tree, op, pageTitle);
  return tree;
}

function applyOne(tree: BlockNode[], op: BlockOp, pageTitle: string): void {
  if (op.op === "create") {
    if (op.page_title !== pageTitle) return;
    if (locate(tree, op.uid)) return; // replay of a block we already have
    const siblings = siblingsOf(tree, op.parent_uid ?? null);
    if (siblings === null) return;    // parent unknown here: skip
    shiftFrom(siblings, op.order_idx);
    siblings.push({
      uid: op.uid, text: op.text, heading: op.heading ?? null,
      view_type: null, collapsed: false, order_idx: op.order_idx,
      created_at: null, updated_at: null, children: [],
    });
    sortSiblings(siblings);
    return;
  }
  if (op.op === "create_page") return; // page creation: no block tree to update here
  const found = locate(tree, op.uid);
  if (!found) return; // op for another page: skip
  if (op.op === "update_text") {
    found.node.text = op.text;
  } else if (op.op === "set_collapsed") {
    found.node.collapsed = op.collapsed;
  } else if (op.op === "set_heading") {
    found.node.heading = op.heading ?? null;
  } else if (op.op === "set_view_type") {
    found.node.view_type = op.view_type;
  } else if (op.op === "delete") {
    found.siblings.splice(found.index, 1);
  } else { // move — order_idx counted BEFORE the moved block is removed
    if (op.page_title != null && op.page_title !== pageTitle) {
      // this outline is the SOURCE of a cross-page move: just remove
      found.siblings.splice(found.index, 1);
      return;
    }
    const target = siblingsOf(tree, op.parent_uid);
    if (target === null) return;
    shiftFrom(target, op.order_idx, op.uid);
    found.siblings.splice(found.index, 1);
    found.node.order_idx = op.order_idx;
    target.push(found.node);
    sortSiblings(target);
  }
}

/** Detach uid's subtree. Returns the new tree and the detached node
 * (null = uid not found; tree returned unchanged). Pure: clones. */
export function removeSubtree(blocks: BlockNode[], uid: string):
    { tree: BlockNode[]; node: BlockNode | null } {
  const tree = clone(blocks);
  const found = locate(tree, uid);
  if (!found) return { tree, node: null };
  found.siblings.splice(found.index, 1);
  return { tree, node: found.node };
}

/** Insert a detached subtree per the move contract (insert before the
 * block currently at orderIdx). Unknown parentUid: returns tree unchanged. */
export function insertSubtree(blocks: BlockNode[], node: BlockNode,
                              parentUid: string | null,
                              orderIdx: number): BlockNode[] {
  const tree = clone(blocks);
  const siblings = siblingsOf(tree, parentUid);
  if (siblings === null) return tree;
  shiftFrom(siblings, orderIdx);
  siblings.push({ ...node, children: clone(node.children), order_idx: orderIdx });
  sortSiblings(siblings);
  return tree;
}
