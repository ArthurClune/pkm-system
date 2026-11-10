// pattern: Functional Core
// The one judge of whether a batch of ops may be queued. The server refuses
// such a batch whole and the queue discards it, so every path that queues
// (a command, an undo or redo replay, a cross-page drop) asks here first.
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { findOpTextLimitViolation,
         textLimitNotice } from "../grammar/textLimits";
import { findOpTitleViolation, titleRefusalNotice } from "../replica/titles";
import { BATCH_TOO_LARGE_NOTICE,
         findBatchSizeViolation } from "../sync/batchLimits";
import { DEPTH_NOTICE, findDepthViolation } from "./depthCap";

/** Why this batch must not be queued, or null. `treeAfter` is null when
 * no tree is known (an unmounted replay whose page read failed), which
 * leaves the depth to the server. `alsoShipping` are ops that ship in the
 * same batch (a draft's text ops): they count toward the size and the
 * titles, not the depth or the text limits. */
export function editRefusal(
  treeAfter: BlockNode[] | null,
  ops: readonly BlockOp[],
  alsoShipping: readonly BlockOp[],
): string | null {
  const places = ops.some((op) => op.op === "create" || op.op === "move");
  if (treeAfter !== null && places
      && findDepthViolation(treeAfter, ops) !== null) {
    return DEPTH_NOTICE;
  }
  const overLimit = findOpTextLimitViolation(ops);
  if (overLimit !== null) return textLimitNotice(overLimit.violation);
  const batch = [...alsoShipping, ...ops];
  if (findBatchSizeViolation(batch) !== null) return BATCH_TOO_LARGE_NOTICE;
  return titleRefusalNotice(findOpTitleViolation(batch)?.reason ?? null);
}
