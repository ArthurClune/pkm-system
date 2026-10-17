// pattern: Functional Core
// Reads a pending_ops row's `ops_json` back into ops. The column is text the
// replica itself wrote, but it sits on disk across releases and tabs, so the
// shape is checked here before its brands (block uids, order keys, hashes)
// are trusted: the one place a stored op list becomes `BlockOp[]`.
import type { BlockOp } from "../api/ops";

export function parsePendingOps(json: string): BlockOp[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) {
    throw new Error("pending ops are not an array");
  }
  for (const op of parsed) {
    if (typeof op !== "object" || op === null
        || typeof (op as { op?: unknown }).op !== "string") {
      throw new Error("a pending op has no op kind");
    }
  }
  return parsed as BlockOp[];
}
