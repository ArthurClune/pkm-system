// pattern: Functional Core
// Which pending rows an ack settles. A recovery lease's ack settles a row
// only when both its row id and its batch id match: an ack held past a run
// whose row the drain has since deleted, or whose id a rebuilt file has since
// reused for another batch, settles nothing. A sync payload's
// `applied_batches` settles the rows that carry a named batch id.

import type { components } from "../api/types";
import type { AckedBatch, DroppedBatch, PendingBatch, PendingRowId } from "./client";
import type { DurablePendingRow } from "./queue";

type AppliedBatch = components["schemas"]["AppliedBatch"];

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

/** The rows a sync payload's `applied_batches` names, in queue order, each
 * with the ack facts the payload gave for it. A poisoned row is never one:
 * the server refused its batch, and the poison repair owns the row. When
 * `droppable` is given, only rows it lists qualify -- the rows that were
 * pending when the pull read the ids it sent, so a row queued since can
 * never go, whatever the payload says. */
export function appliedPendingRows(
  rows: readonly PendingBatch[], applied: readonly AppliedBatch[],
  droppable?: ReadonlySet<PendingRowId>,
): DroppedBatch[] {
  if (applied.length === 0) return [];
  const byBatch = new Map(applied.map((a) => [a.batch_id, a]));
  const out: DroppedBatch[] = [];
  for (const row of rows) {
    if (row.poisoned) continue;
    if (droppable !== undefined && !droppable.has(row.id)) continue;
    const named = byBatch.get(row.batch_id);
    if (named === undefined) continue;
    out.push({ id: row.id, batch_id: row.batch_id, seq: named.seq,
               skipped: named.skipped });
  }
  return out;
}
