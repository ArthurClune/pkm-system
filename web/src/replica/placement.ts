// pattern: Functional Core
// Where the replica's local apply puts a create or move, as the server's
// ops_apply does (shared/fixtures/missing_targets.json pins both sides).
// Under a live parent the block lands on the parent's page, whatever its
// page_title says: page_title places only a top-level create or move. A
// replay (reapply) finds its own create and move effects already in place
// and keeps them rather than failing or shifting again. localOps.ts
// gathers the facts and runs the SQL for the verdict.

import type { BlockUid, PageId } from "../api/brands";
import type { CreateOp, MoveOp } from "../api/ops";
import { skipsOnMissingTarget } from "./missingTarget";

/** `block`: the row op.uid names. `parent`: the row a create/move's
 * parent_uid names. `parentChain`: that parent and its ancestors, read
 * only for a move whose block and parent both exist. `titlePageId`: the
 * existing page titled a top-level move's page_title, looked up without
 * creating it; null when there is no such page. */
export interface PlacementFacts {
  block: { page_id: PageId; parent_uid: BlockUid | null; order_idx: number } | null;
  parent: { page_id: PageId } | null;
  parentChain: readonly BlockUid[];
  titlePageId: PageId | null;
}

/** `keep`: the row is already this op's own; leave its slot, re-paging its
 * subtree to `repageTo` first when that is set. `place`: shift the target's
 * siblings and write the row there. A `{ title }` page is resolved (and
 * created if missing) by the shell; `repage` moves the subtree with it. */
export type Placement =
  | { kind: "skip" }
  | { kind: "keep"; repageTo: PageId | null }
  | { kind: "place"; page: { id: PageId } | { title: string };
      parentUid: BlockUid | null; orderIdx: number; repage: boolean };

export function placementFor(op: CreateOp | MoveOp, facts: PlacementFacts,
                             reapply: boolean): Placement {
  const { block, parent } = facts;
  if (skipsOnMissingTarget(op, block !== null, parent !== null,
                           facts.parentChain)) {
    return { kind: "skip" };
  }
  const parentUid = op.parent_uid ?? null;
  if (op.op === "create") {
    // On replay the row is this create's own: the enqueue-time apply, or
    // the server's echo. It follows a parent the window moved to another
    // page, as the server will place it, but only while it is still under
    // that parent: a later pending move that took it elsewhere owns its
    // page, and re-paging it here would make that move's replay re-shift
    // its target's children on every window.
    if (reapply && block !== null) {
      const follows = parent !== null && block.parent_uid === parentUid
        && block.page_id !== parent.page_id;
      return { kind: "keep", repageTo: follows ? parent.page_id : null };
    }
    // Otherwise an existing uid fails the INSERT, as the server 400s.
    return { kind: "place",
             page: parent !== null ? { id: parent.page_id }
                                   : { title: op.page_title },
             parentUid, orderIdx: op.order_idx, repage: false };
  }
  // past the skip check, a move names an existing block
  const moved = block!;
  const title = parent === null ? op.page_title ?? null : null;
  const page = parent !== null ? { id: parent.page_id }
    : title !== null ? { title } : { id: moved.page_id };
  // A title with no page yet names a page the block cannot already be on.
  const targetPageId = "id" in page ? page.id : facts.titlePageId;
  if (reapply && targetPageId === moved.page_id
      && moved.parent_uid === parentUid && moved.order_idx === op.order_idx) {
    return { kind: "keep", repageTo: null };
  }
  return { kind: "place", page, parentUid, orderIdx: op.order_idx,
           repage: targetPageId !== moved.page_id };
}
