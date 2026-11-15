// pattern: Functional Core
// The rows a table view shows, for query tables and plain tables alike:
// those the live filter keeps, in the live sort's order, or, once a cell
// edit has frozen the view, the frozen rows in their frozen order with the
// ones that stopped matching marked stale.
import { matchesFilter, parseFilter, type FilterRow } from "./filter";
import { sortRows } from "./sort";
import type { ViewFields } from "./viewState";

export interface Shown<T> {
  item: T;
  row: FilterRow;
  stale: boolean;
}

/** `matching` is the "N" of "N of M": the rows shown that still match the
 * filter. `searched` names the FilterRow keys a plain word looks in. */
export function viewRows<T>(
  items: readonly T[], id: (t: T) => string, rowOf: (t: T) => FilterRow,
  searched: readonly string[], live: ViewFields,
  frozen: readonly string[] | null,
): { rows: Shown<T>[]; matching: number } {
  const terms = parseFilter(live.filter);
  const all = items.map((item) => {
    const row = rowOf(item);
    return { item, row, stale: !matchesFilter(row, terms, searched) };
  });
  if (frozen !== null) {
    const byId = new Map(all.map((r) => [id(r.item), r]));
    const rows = frozen.flatMap((key) => byId.get(key) ?? []);
    return { rows, matching: rows.filter((r) => !r.stale).length };
  }
  const kept = all.filter((r) => !r.stale);
  const sort = live.sort;
  const rows = sort === null ? kept
    : sortRows(kept, (r) => r.row[sort.col], sort.dir);
  return { rows, matching: rows.length };
}
