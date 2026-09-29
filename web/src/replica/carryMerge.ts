// pattern: Functional Core
// Which pending rows a replica file replaced during carry adoption must
// keep. A carry whose write failed or was cut short holds fewer rows than
// the replica it was written from, so the new file takes every row either
// copy still holds.

import type { DurablePendingRow } from "./queue";

/** Every row in `carried` or `held`, by id, oldest first. On an id both hold,
 * the carry's row wins. Both copies were written from the same rows, since
 * no handler can change the queue while a carry exists, so they differ only
 * where one file is torn, and nothing says which. The carry is the copy
 * written to outlive a replacement, so it is the one kept. */
export function mergeCarriedRows(
  carried: readonly DurablePendingRow[], held: readonly DurablePendingRow[],
): DurablePendingRow[] {
  const byId = new Map<number, DurablePendingRow>();
  for (const row of held) byId.set(row.id, row);
  for (const row of carried) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}
