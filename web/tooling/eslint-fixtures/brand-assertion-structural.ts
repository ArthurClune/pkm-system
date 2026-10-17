import type { BatchId, BlockUid } from "../../src/api/brands";

interface PendingOp {
  batch_id: BatchId;
}

export function rowsOf(rows: unknown): { uid: BlockUid }[] {
  return rows as { uid: BlockUid }[];
}
export function opOf(s: string): PendingOp {
  return JSON.parse(s) as PendingOp;
}
