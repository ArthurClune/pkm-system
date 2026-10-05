// pattern: Functional Core
// Where the replica's local apply puts a create or move, as the server's
// ops_apply does (shared/fixtures/missing_targets.json pins both sides).
// Under a live parent the block lands on the parent's page, whatever its
// page_title says: page_title places only a top-level create or move. A
// feed window rewinds a pending batch before replaying it, so a replay
// places its creates and moves exactly as the first apply did. localOps.ts
// gathers the facts and runs the SQL for the verdict.

import type { BlockUid, OrderIdx, PageId } from "../api/brands";
import type { CreateOp, MoveOp } from "../api/ops";
import { skipsOnMissingTarget } from "./missingTarget";

/** `block`: the row op.uid names. `parent`: the row a create/move's
 * parent_uid names. `parentChain`: that parent and its ancestors, read
 * only for a move whose block and parent both exist. `titlePageId`: the
 * existing page titled a top-level move's page_title, looked up without
 * creating it; null when there is no such page. */
export interface PlacementFacts {
  block: { page_id: PageId; parent_uid: BlockUid | null; order_idx: OrderIdx } | null;
  parent: { page_id: PageId } | null;
  parentChain: readonly BlockUid[];
  titlePageId: PageId | null;
}

/** `place`: shift the target's siblings and write the row there. A
 * `{ title }` page is resolved (and created if missing) by the shell;
 * `repage` moves the subtree with it. */
export type Placement =
  | { kind: "skip" }
  | { kind: "place"; page: { id: PageId } | { title: string };
      parentUid: BlockUid | null; orderIdx: OrderIdx; repage: boolean };

export function placementFor(op: CreateOp | MoveOp,
                             facts: PlacementFacts): Placement {
  const { block, parent } = facts;
  if (skipsOnMissingTarget(op, block !== null, parent !== null,
                           facts.parentChain)) {
    return { kind: "skip" };
  }
  const parentUid = op.parent_uid ?? null;
  if (op.op === "create") {
    // An existing uid fails the INSERT, as the server 400s.
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
  return { kind: "place", page, parentUid, orderIdx: op.order_idx,
           repage: targetPageId !== moved.page_id };
}
