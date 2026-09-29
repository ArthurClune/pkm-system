// pattern: Functional Core
// Which ops the replica's local apply skips on a missing target: the same
// ops the server's ops_core.classify_missing_target skips (pkm-7788), so a
// re-applied batch keeps its valid ops instead of rolling back whole. Both
// sides pass shared/fixtures/missing_targets.json. Only skip-or-not is
// mirrored; the daily-note landing is the server's, and reaches the replica
// through the feed.

import type { BlockOp } from "../api/ops";

/** `blockExists`: op.uid names a row. `parentExists`: a create/move's
 * parent_uid does (ignored when there is none). A create onto an existing
 * uid is not skipped; it fails as it does on the server. */
export function skipsOnMissingTarget(
  op: BlockOp, blockExists: boolean, parentExists: boolean,
): boolean {
  if (op.op === "create_page") return false;
  const parentUid = op.op === "create" || op.op === "move"
    ? op.parent_uid ?? null : null;
  if (op.op === "create") {
    return !blockExists && parentUid !== null && !parentExists;
  }
  if (blockExists) {
    return op.op === "move" && parentUid !== null && !parentExists;
  }
  return true;
}
