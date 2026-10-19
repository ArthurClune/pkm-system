// pattern: Functional Core
// Reads a pending_ops row's `ops_json` back into ops. The text is our own
// write (queue.ts stores `JSON.stringify(BlockOp[])`), so this is a trusted
// decode: it checks nothing beyond what JSON.parse does, and a throw here
// would wedge init, the pull loop and the drain. It is the one place a
// stored op list becomes `BlockOp[]`.
import type { BlockOp } from "../api/ops";

export function parsePendingOps(json: string): BlockOp[] {
  return JSON.parse(json) as BlockOp[];
}
