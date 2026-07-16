import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_ASPECT,
  currentPageFromRatios,
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
});
