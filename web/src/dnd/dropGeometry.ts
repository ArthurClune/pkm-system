// pattern: Functional Core
// Drop-zone geometry over measured rectangles: which boundary a pointer is
// at, where the indicator line goes, and whether a rect cache taken earlier
// in the drag may still be used.
//
// Both lookups take a `rectAt(index)` getter rather than an array, because
// the walk is what makes them cheap: it stops at the first row whose midpoint
// is below the pointer, so a drag near the top of a 300-row outline never
// asks about row 40. Measuring every row up front to hand in an array would
// spend the whole saving on the first dragover. The getter is the hook's
// lazily-filled cache; every DOM read stays there.
import type { DragSource, DropRow } from "../outline/dnd";

/** A row's vertical extent in viewport (client) coordinates — the two
 * fields of a DOMRect the drop zone actually uses. */
export interface RowRect { top: number; bottom: number }

/** A measured row, or null for a row with no element on screen. */
export type RectAt = (index: number) => RowRect | null;

/** One drag's worth of measurements. `rects` is index-aligned with the
 * `DropRow[]` it was measured against; `undefined` means not yet measured. */
export interface RectCache {
  /** The drag it was measured during — see `cacheIsUsable`. */
  drag: DragSource;
  rowCount: number;
  containerTop: number;
  containerLeft: number;
  rects: (RowRect | null | undefined)[];
}

/** Boundary index for `clientY` among `rows`. Above a row's midpoint = the
 * boundary before it; below every midpoint = rows.length. Rows with no rect
 * are skipped, exactly as an unfound element was. */
export function boundaryFromRects(rows: DropRow[], rectAt: RectAt,
                                  clientY: number): number {
  for (let i = 0; i < rows.length; i++) {
    const r = rectAt(i);
    if (!r) continue;
    if (clientY < (r.top + r.bottom) / 2) return i;
  }
  return rows.length;
}

/** y-position (relative to the container) for the indicator at `boundary`:
 * the top of the row it sits above, or the bottom of the last row. */
export function indicatorTopFromRects(rows: DropRow[], rectAt: RectAt,
                                      containerTop: number,
                                      boundary: number): number {
  if (rows.length === 0) return 0;
  if (boundary < rows.length) {
    const r = rectAt(boundary);
    return r ? r.top - containerTop : 0;
  }
  const r = rectAt(rows.length - 1);
  return r ? r.bottom - containerTop : 0;
}

/** May a cache measured earlier still be used?
 *
 * Rows do not move while a drag is in progress — nothing edits the outline
 * and nothing collapses — which is what makes caching a whole drag's rects
 * sound. Three things do move them, and each must throw the cache away
 * rather than try to shift it:
 *
 *   - a scroll or a resize, because the cached tops are viewport-relative
 *     and the pointer's `clientY` is compared against them. The hook
 *     invalidates on those events; they are invisible from here.
 *   - a row appearing or vanishing — a remote edit landing mid-drag — which
 *     re-lays-out everything below it. Row count catches that, and the drag
 *     itself cannot change the count: `dropRows` hides the dragged subtree
 *     from the first measurement onwards.
 *   - the end of the drag. The drop that ended it reordered rows, so a cache
 *     surviving into the next drag would describe the old layout; the drag
 *     identity is checked rather than relied on having been cleared.
 */
export function cacheIsUsable(cache: RectCache | null, drag: DragSource,
                              rows: DropRow[]): boolean {
  return cache !== null && cache.drag === drag
    && cache.rowCount === rows.length;
}
