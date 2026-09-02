import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_ASPECT,
  currentPageFromRatios,
  focusWrapTarget,
  mountedPageWindow,
  placeholderHeight,
  retainPages,
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

describe("mountedPageWindow", () => {
  const set = (...pages: number[]) => new Set(pages);

  it("keeps page 1 when nothing is near the viewport yet", () => {
    expect(mountedPageWindow(set(), 20, 3)).toEqual(set(1));
  });

  it("keeps a radius either side of the near page", () => {
    expect(mountedPageWindow(set(10), 20, 3)).toEqual(set(7, 8, 9, 10, 11, 12, 13));
  });

  it("clamps the window to the document's own page range", () => {
    expect(mountedPageWindow(set(2), 20, 3)).toEqual(set(1, 2, 3, 4, 5));
    expect(mountedPageWindow(set(19), 20, 3)).toEqual(set(16, 17, 18, 19, 20));
  });

  it("unions the windows of several near pages", () => {
    expect(mountedPageWindow(set(5, 6), 20, 1)).toEqual(set(4, 5, 6, 7));
  });

  it("does not bridge a gap between two distant near pages", () => {
    expect(mountedPageWindow(set(2, 18), 20, 1)).toEqual(set(1, 2, 3, 17, 18, 19));
  });

  it("drops a page number the document does not have", () => {
    expect(mountedPageWindow(set(99), 3, 1)).toEqual(set());
  });

  it("keeps everything in a document smaller than the window", () => {
    expect(mountedPageWindow(set(2), 3, 3)).toEqual(set(1, 2, 3));
  });

  it("a zero radius keeps only the near pages themselves", () => {
    expect(mountedPageWindow(set(4, 9), 20, 0)).toEqual(set(4, 9));
  });
});

describe("retainPages", () => {
  it("returns the same set when nothing needs dropping", () => {
    const rendered = new Set([1, 2]);
    // identity matters: this feeds a setState, and a fresh equal Set would
    // re-render every slot on every observer callback
    expect(retainPages(rendered, new Set([1, 2, 3]))).toBe(rendered);
  });

  it("drops the pages that are no longer mounted", () => {
    expect(retainPages(new Set([1, 2, 9]), new Set([1, 2])))
      .toEqual(new Set([1, 2]));
  });

  it("returns an empty set when nothing is kept", () => {
    expect(retainPages(new Set([4]), new Set())).toEqual(new Set());
  });

  it("returns the same empty set rather than a new one", () => {
    const rendered = new Set<number>();
    expect(retainPages(rendered, new Set([1]))).toBe(rendered);
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
