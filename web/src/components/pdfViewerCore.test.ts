import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_ASPECT,
  currentPageFromRatios,
  focusWrapTarget,
  placeholderHeight,
} from "./pdfViewerCore";

describe("currentPageFromRatios", () => {
  it("returns 1 when nothing has been measured", () => {
    expect(currentPageFromRatios(new Map())).toBe(1);
  });

  it("returns the page with the largest visible fraction", () => {
    const ratios = new Map([[1, 0.1], [2, 0.85], [3, 0.05]]);
    expect(currentPageFromRatios(ratios)).toBe(2);
  });

  it("breaks ties toward the earliest page", () => {
    const ratios = new Map([[3, 0.5], [2, 0.5]]);
    expect(currentPageFromRatios(ratios)).toBe(2);
  });

  it("ignores pages that scrolled fully out of view", () => {
    const ratios = new Map([[1, 0], [2, 0], [3, 0.4]]);
    expect(currentPageFromRatios(ratios)).toBe(3);
  });

  it("returns 1 when page 1 is unmeasured and every measured page is at 0", () => {
    const ratios = new Map([[2, 0], [3, 0]]);
    expect(currentPageFromRatios(ratios)).toBe(1);
  });
});

describe("focusWrapTarget", () => {
  const [a, b, c] = ["a", "b", "c"];

  it("returns null when there is nothing to trap", () => {
    expect(focusWrapTarget([], a, false)).toBeNull();
    expect(focusWrapTarget([], a, true)).toBeNull();
  });

  it("Tab from the last focusable wraps to the first", () => {
    expect(focusWrapTarget([a, b, c], c, false)).toBe(a);
  });

  it("Shift+Tab from the first focusable wraps to the last", () => {
    expect(focusWrapTarget([a, b, c], a, true)).toBe(c);
  });

  it("returns null mid-list so the browser's own tab order runs", () => {
    expect(focusWrapTarget([a, b, c], b, false)).toBeNull();
    expect(focusWrapTarget([a, b, c], b, true)).toBeNull();
  });

  it("pulls focus back inside when the active element escaped the trap", () => {
    expect(focusWrapTarget([a, b, c], "elsewhere", false)).toBe(a);
    expect(focusWrapTarget([a, b, c], "elsewhere", true)).toBe(c);
    expect(focusWrapTarget([a, b, c], null, false)).toBe(a);
  });

  it("a single focusable always wraps to itself", () => {
    expect(focusWrapTarget([a], a, false)).toBe(a);
    expect(focusWrapTarget([a], a, true)).toBe(a);
  });
});

describe("placeholderHeight", () => {
  it("multiplies width by the page aspect", () => {
    expect(placeholderHeight(600, 792 / 612)).toBe(Math.round(600 * (792 / 612)));
  });

  it("falls back to the A-series default before page 1 is measured", () => {
    expect(placeholderHeight(500, null)).toBe(Math.round(500 * DEFAULT_PAGE_ASPECT));
  });

  it("never returns less than 1 (unmeasured container)", () => {
    expect(placeholderHeight(0, null)).toBe(1);
  });

  it("clamps a negative width to the 1px floor", () => {
    expect(placeholderHeight(-300, null)).toBe(1);
  });

  it("guards against non-finite width", () => {
    expect(placeholderHeight(Number.NaN, null)).toBe(1);
    expect(placeholderHeight(Number.POSITIVE_INFINITY, null)).toBe(1);
  });
});
