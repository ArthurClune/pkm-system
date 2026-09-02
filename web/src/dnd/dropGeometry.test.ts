import { describe, expect, it } from "vitest";
import type { DropRow } from "../outline/dnd";
import { boundaryFromRects, cacheIsUsable, indicatorTopFromRects,
         type RowRect } from "./dropGeometry";

const rows = (n: number): DropRow[] =>
  Array.from({ length: n }, (_, i) =>
    ({ uid: `u${i + 1}`, depth: 0, collapsed: false }));

/** Rows 20px tall stacked from clientY=100 — so midpoints land at 110, 130,
 * 150, ... — plus a record of which ones were actually looked up. `holes`
 * are rows with no element on screen. */
function stack(holes: number[] = []) {
  const asked: number[] = [];
  const rectAt = (i: number): RowRect | null => {
    asked.push(i);
    if (holes.includes(i)) return null;
    return { top: 100 + i * 20, bottom: 100 + (i + 1) * 20 };
  };
  return { rectAt, asked };
}

describe("boundaryFromRects", () => {
  it("above a row's midpoint is the boundary before it", () => {
    expect(boundaryFromRects(rows(3), stack().rectAt, 0)).toBe(0);
    expect(boundaryFromRects(rows(3), stack().rectAt, 109)).toBe(0);
    expect(boundaryFromRects(rows(3), stack().rectAt, 111)).toBe(1);
    expect(boundaryFromRects(rows(3), stack().rectAt, 131)).toBe(2);
  });

  it("below every midpoint is the boundary after the last row", () => {
    expect(boundaryFromRects(rows(3), stack().rectAt, 999)).toBe(3);
  });

  it("no rows means the only boundary is 0", () => {
    expect(boundaryFromRects([], stack().rectAt, 500)).toBe(0);
  });

  it("asks about no more rows than it needs — the whole point of the getter",
     () => {
    const s = stack();
    expect(boundaryFromRects(rows(300), s.rectAt, 111)).toBe(1);
    expect(s.asked).toEqual([0, 1]);
  });

  it("skips a row with no rect, exactly as an unfound element was skipped",
     () => {
    // clientY 105 is above row 0's midpoint, but row 0 is unmeasurable: the
    // answer comes from row 1, whose midpoint (130) is still below.
    expect(boundaryFromRects(rows(3), stack([0]).rectAt, 105)).toBe(1);
  });
});

describe("indicatorTopFromRects", () => {
  it("sits at the top of the row the boundary is above", () => {
    // container top 40: row 1 starts at clientY 120, so 80px down the zone
    expect(indicatorTopFromRects(rows(3), stack().rectAt, 40, 1)).toBe(80);
  });

  it("sits at the bottom of the last row for the final boundary", () => {
    expect(indicatorTopFromRects(rows(3), stack().rectAt, 40, 3)).toBe(120);
  });

  it("is 0 with no rows, and 0 when the row it needs is unmeasurable", () => {
    expect(indicatorTopFromRects([], stack().rectAt, 40, 0)).toBe(0);
    expect(indicatorTopFromRects(rows(3), stack([1]).rectAt, 40, 1)).toBe(0);
    expect(indicatorTopFromRects(rows(3), stack([2]).rectAt, 40, 3)).toBe(0);
  });
});

describe("cacheIsUsable", () => {
  const drag = { uid: "u1", pageTitle: "P" };
  const cache = (over: object) =>
    ({ drag, rowCount: 3, containerTop: 0, containerLeft: 0,
       rects: [], ...over });

  it("reuses a cache measured against this drag and this many rows", () => {
    expect(cacheIsUsable(cache({}), drag, rows(3))).toBe(true);
  });

  it("never reuses a cache from a previous drag", () => {
    // the drop that ended the last drag re-laid-out the rows it moved
    expect(cacheIsUsable(cache({}), { uid: "u1", pageTitle: "P" }, rows(3)))
      .toBe(false);
  });

  it("rejects a cache whose row count no longer matches", () => {
    // a remote edit landing mid-drag inserts or removes a row, which moves
    // everything below it
    expect(cacheIsUsable(cache({}), drag, rows(4))).toBe(false);
    expect(cacheIsUsable(cache({}), drag, rows(2))).toBe(false);
  });

  it("has nothing to reuse when the cache was invalidated", () => {
    expect(cacheIsUsable(null, drag, rows(3))).toBe(false);
  });
});
