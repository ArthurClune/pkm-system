import { describe, expect, it } from "vitest";
import { compareCells, sortRows } from "./sort";

const sorted = (cells: (string | undefined)[], dir: "asc" | "desc") =>
  sortRows(cells, (c) => c, dir);

describe("compareCells", () => {
  it("sorts empty cells last in both directions", () => {
    expect(sorted(["", "b", undefined, "a", "  "], "asc")).toEqual([
      "a", "b", "", undefined, "  ",
    ]);
    expect(sorted(["", "b", undefined, "a"], "desc")).toEqual([
      "b", "a", "", undefined,
    ]);
  });

  it("compares dates", () => {
    expect(compareCells("Mar 2026", "Feb 2026", "asc")).toBeGreaterThan(0);
    expect(compareCells("Jan 2026", "2025", "asc")).toBeGreaterThan(0);
    expect(compareCells("2025", "Jan 2025", "asc")).toBeLessThan(0);
    expect(compareCells("january 26", "JAN 2026", "asc")).toBe(0);
    expect(compareCells("Dec 2025", "Jan 2026", "desc")).toBeGreaterThan(0);
    expect(compareCells("2017", "2025", "asc")).toBeLessThan(0);
  });

  it("compares numbers by leading value", () => {
    expect(compareCells("0.014", "0.044", "asc")).toBeLessThan(0);
    expect(compareCells("9 apples", "10 pears", "asc")).toBeLessThan(0);
    expect(compareCells(".5", "0.25", "asc")).toBeGreaterThan(0);
  });

  it("compares text case-insensitively without markup", () => {
    expect(compareCells("[[apple]]", "Banana", "asc")).toBeLessThan(0);
    expect(compareCells("#Zed", "apple", "asc")).toBeGreaterThan(0);
    expect(compareCells("ABC", "abc", "asc")).toBe(0);
    expect(compareCells("a2", "a10", "asc")).toBeLessThan(0);
  });

  it("falls back to text for mixed kinds", () => {
    expect(compareCells("Jan 2026", "apple", "asc")).toBeGreaterThan(0);
  });
});

describe("sortRows", () => {
  it("is stable and does not mutate", () => {
    const rows = [
      { k: "b", i: 0 }, { k: "a", i: 1 }, { k: "b", i: 2 }, { k: "a", i: 3 },
    ];
    const copy = [...rows];
    expect(sortRows(rows, (r) => r.k, "asc").map((r) => r.i)).toEqual([1, 3, 0, 2]);
    expect(sortRows(rows, (r) => r.k, "desc").map((r) => r.i)).toEqual([0, 2, 1, 3]);
    expect(rows).toEqual(copy);
  });
});
