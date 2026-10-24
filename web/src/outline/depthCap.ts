// pattern: Functional Core
// The outline depth cap: the deepest level a create or move may put a block
// at, a top-level block being level 1. The server refuses a batch past it
// (ops_core.plan_op), because an outline 255 levels deep made its page reads
// fail; the editor refuses first, so the user sees why. Only where an op
// places blocks is judged: rows already past the cap stay editable.
import type { BlockUid } from "../api/brands";
import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";

// shared/fixtures/outline_depth.json pins this equal to the server's.
export const MAX_OUTLINE_DEPTH = 100;

export const DEPTH_NOTICE = "Blocks can't nest more than 100 levels deep.";

/** How many levels the node's deepest descendant sits below it; 0 for a
 * leaf. */
export function subtreeHeight(node: BlockNode): number {
  let height = 0;
  for (const child of node.children) {
    height = Math.max(height, 1 + subtreeHeight(child));
  }
  return height;
}

/** The first create or move in `ops` whose block, with its subtree, reaches
 * past `max` in `after` (the tree with the ops applied), else null. An op
 * whose block is not in `after` (moved to another page) is not judged; the
 * server judges it against the tree it lands in. */
export function findDepthViolation(after: BlockNode[], ops: readonly BlockOp[],
                                   max: number = MAX_OUTLINE_DEPTH,
): BlockUid | null {
  const judged = new Set<BlockUid>();
  for (const op of ops) {
    if (op.op === "create" || op.op === "move") judged.add(op.uid);
  }
  if (judged.size === 0) return null;
  // the level of the deepest block in each judged block's subtree
  const deepest = new Map<BlockUid, number>();
  const walk = (nodes: BlockNode[], level: number): number => {
    let reached = 0;
    for (const node of nodes) {
      const below = Math.max(level, walk(node.children, level + 1));
      if (judged.has(node.uid)) deepest.set(node.uid, below);
      reached = Math.max(reached, below);
    }
    return reached;
  };
  walk(after, 1);
  for (const op of ops) {
    if (op.op !== "create" && op.op !== "move") continue;
    if ((deepest.get(op.uid) ?? 0) > max) return op.uid;
  }
  return null;
}
