import type { BatchId, BlockUid } from "../../src/api/brands";
interface PendingOp {
  batch_id: BatchId;
}
export function rowsOf(rows: { uid: BlockUid }[]): BlockUid[] {
  return rows.map((r) => r.uid);
}
export function opOf(s: string): unknown {
  const v: unknown = JSON.parse(s);
  return v;
}
