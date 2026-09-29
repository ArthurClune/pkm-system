// pattern: Functional Core
// Which of a recovery lease's durable rows an ack list settles. An ack
// settles a row only when both its row id and its batch id match: an ack
// held past a run whose row the drain has since deleted, or whose id a
// rebuilt file has since reused for another batch, settles nothing.

import type { AckedBatch } from "./client";
import type { DurablePendingRow } from "./queue";

export function splitAckedRows(
  rows: readonly DurablePendingRow[], acked: readonly AckedBatch[],
): { settled: AckedBatch[]; remaining: DurablePendingRow[] } {
  const settled: AckedBatch[] = [];
  const remaining: DurablePendingRow[] = [];
  for (const row of rows) {
    // the first matching entry wins, so a row is settled at most once
    const ack = acked.find(
      (a) => a.id === row.id && a.batch_id === row.batch_id);
    if (ack) settled.push(ack);
    else remaining.push(row);
  }
  return { settled, remaining };
}
