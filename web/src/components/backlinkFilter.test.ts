import { describe, expect, it } from "vitest";
import type { BacklinkGroup } from "../api/payloads";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, itemRefTitles,
         toggleChip } from "./backlinkFilter";

const item = (uid: string, text: string, breadcrumbs: string[] = []) =>
  ({ uid, text, breadcrumbs });

const groups: BacklinkGroup[] = [
  { page_id: 1, page_title: "Daily A", items: [
    item("u1", "alpha [[Claude]] #Paper"),
    item("u2", "beta [[Claude]] #Idea")] },
  { page_id: 2, page_title: "Daily B", items: [
    item("u3", "gamma [[Claude]]", ["reading list #Paper"])] },
];

describe("itemRefTitles", () => {
  it("collects titles from text and breadcrumb ancestors", () => {
    const refs = itemRefTitles(item("u3", "gamma [[Claude]]", ["reading #Paper"]));
    expect(refs).toEqual(new Set(["Claude", "Paper"]));
  });

  it("merges link, tag and attribute forms of the same title", () => {
    const refs = itemRefTitles(item("u9", "[[Paper]] #Paper Paper:: x #[[Constitutional AI]]"));
    expect(refs).toEqual(new Set(["Paper", "Constitutional AI"]));
  });
});

describe("applyFilter", () => {
  it("returns groups untouched for the empty filter", () => {
    expect(applyFilter(groups, EMPTY_FILTER)).toBe(groups);
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
  });

  it("include keeps only items referencing ALL included titles", () => {
    const out = applyFilter(groups, { include: ["Paper"], exclude: [] });
    expect(out.map((g) => g.items.map((i) => i.uid))).toEqual([["u1"], ["u3"]]);
    const both = applyFilter(groups, { include: ["Paper", "Idea"], exclude: [] });
    expect(both).toEqual([]); // no single item carries both
  });

  it("exclude hides items (breadcrumb refs count) and drops empty groups", () => {
    const out = applyFilter(groups, { include: [], exclude: ["Paper"] });
    // u1 excluded by own text, u3 by ancestor; Daily B disappears entirely
    expect(out.map((g) => g.items.map((i) => i.uid))).toEqual([["u2"]]);
  });
});

describe("chipCounts", () => {
  it("counts items per title, omitting the given titles, sorted by count then title", () => {
    expect(chipCounts(groups, ["Claude"])).toEqual([
      { title: "Paper", count: 2 },
      { title: "Idea", count: 1 },
    ]);
  });

  it("ties break alphabetically", () => {
    const g: BacklinkGroup[] = [{ page_id: 1, page_title: "X", items: [
      item("u1", "#zebra #apple")] }];
    expect(chipCounts(g, [])).toEqual([
      { title: "apple", count: 1 }, { title: "zebra", count: 1 }]);
  });
});

describe("toggleChip", () => {
  it("adds, clears on re-toggle, and moves between sides", () => {
    const inc = toggleChip(EMPTY_FILTER, "Paper", "include");
    expect(inc).toEqual({ include: ["Paper"], exclude: [] });
    expect(toggleChip(inc, "Paper", "include")).toEqual(EMPTY_FILTER);
    const moved = toggleChip(inc, "Paper", "exclude");
    expect(moved).toEqual({ include: [], exclude: ["Paper"] });
  });
});
