// pattern: Functional Core
// Reading an /api/ops ack.
import type { OpsAck, SkippedOp } from "../api/payloads";

export type SkipReason = SkippedOp["reason"];

export interface OpsAckReading {
  /** The journal seq of the batch's commit; undefined when the ack names none
   * (null, absent, or not a finite number). */
  seq: number | undefined;
  /** Every op the server skipped; empty when absent or not an array. */
  skipped: readonly SkippedOp[];
}

/** Reads an /api/ops ack's `seq` and `skipped` through the generated
 * `OpsAck` type. The parameter is the generated type, but the body still
 * guards at runtime: the value is parsed network JSON, and the type states
 * what the server sends without checking it. An ack stored before `seq` or
 * `skipped` existed reads as unknown seq / no skips, the same as a
 * malformed value would. Serves the drain, the lane and the recovery
 * flush -- every caller that reads an ack. */
export function readOpsAck(ack: OpsAck): OpsAckReading {
  const seq = (ack as { seq?: unknown }).seq;
  const skipped = (ack as { skipped?: unknown }).skipped;
  return {
    seq: typeof seq === "number" && Number.isFinite(seq) ? seq : undefined,
    skipped: Array.isArray(skipped) ? skipped as SkippedOp[] : [],
  };
}
