import { describe, expect, it } from "vitest";
import type { ShownBacklinkGroup } from "./groups";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, itemRefTitles,
         toggleChip } from "./backlinkFilter";
import { pageIdOf, canonicalTitleOf, uidOf } from "../test-helpers";
import { titleReaderFor } from "../sync/titleCanonicalization";

const off = titleReaderFor(false);
const on = titleReaderFor(true);
const T = canonicalTitleOf;

const item = (tag: string, text: string, crumbs: string[] = []) =>
  ({ uid: uidOf(`tuid-${tag}`), text, crumbs });

const groups: ShownBacklinkGroup[] = [
  { page_id: pageIdOf(1), page_title: canonicalTitleOf("Daily A"), items: [
    item("u1", "alpha [[Claude]] #Paper"),
    item("u2", "beta [[Claude]] #Idea")] },
  { page_id: pageIdOf(2), page_title: canonicalTitleOf("Daily B"), items: [
    item("u3", "gamma [[Claude]]", ["reading list #Paper"])] },
];

describe("itemRefTitles", () => {
  it("collects titles from text and breadcrumb ancestors", () => {
    const refs = itemRefTitles(item("u3", "gamma [[Claude]]", ["reading #Paper"]), off);
    expect(refs).toEqual(new Set(["Claude", "Paper"]));
  });

  it("merges link, tag and attribute forms of the same title", () => {
    const refs = itemRefTitles(item("u9", "[[Paper]] #Paper Paper:: x #[[Constitutional AI]]"), off);
    expect(refs).toEqual(new Set(["Paper", "Constitutional AI"]));
  });
});

describe("applyFilter", () => {
  it("returns groups untouched for the empty filter", () => {
    expect(applyFilter(groups, EMPTY_FILTER, off)).toBe(groups);
    expect(isFiltering(EMPTY_FILTER)).toBe(false);
  });

  it("include keeps only items referencing ALL included titles", () => {
    const out = applyFilter(groups, { include: [T("Paper")], exclude: [] }, off);
    expect(out.map((g) => g.items.map((i) => i.uid))).toEqual([["tuid-u1"], ["tuid-u3"]]);
    const both = applyFilter(groups, { include: [T("Paper"), T("Idea")], exclude: [] }, off);
    expect(both).toEqual([]); // no single item carries both
  });

  it("exclude hides items (breadcrumb refs count) and drops empty groups", () => {
    const out = applyFilter(groups, { include: [], exclude: [T("Paper")] }, off);
    // u1 excluded by own text, u3 by ancestor; Daily B disappears entirely
    expect(out.map((g) => g.items.map((i) => i.uid))).toEqual([["tuid-u2"]]);
  });
});

describe("chipCounts", () => {
  it("counts items per title, omitting the given titles, sorted by count then title", () => {
    expect(chipCounts(groups, [T("Claude")], off)).toEqual([
      { title: "Paper", count: 2 },
      { title: "Idea", count: 1 },
    ]);
  });

  it("ties break alphabetically", () => {
    const g: ShownBacklinkGroup[] = [{ page_id: pageIdOf(1), page_title: canonicalTitleOf("X"), items: [
      item("u1", "#zebra #apple")] }];
    expect(chipCounts(g, [], off)).toEqual([
      { title: "apple", count: 1 }, { title: "zebra", count: 1 }]);
  });
});

describe("toggleChip", () => {
  it("adds, clears on re-toggle, and moves between sides", () => {
    const inc = toggleChip(EMPTY_FILTER, T("Paper"), "include");
    expect(inc).toEqual({ include: [T("Paper")], exclude: [] });
    expect(toggleChip(inc, T("Paper"), "include")).toEqual(EMPTY_FILTER);
    const moved = toggleChip(inc, T("Paper"), "exclude");
    expect(moved).toEqual({ include: [], exclude: [T("Paper")] });
  });
});

// Under the plain-space flag the server indexes `[[ AI ]]` and `[[ML ]]` as
// refs to the pages "AI" and "ML", so these blocks are backlinks of "AI" and
// every ML spelling is one page. With the flag off a padded title is a
// distinct page and stays distinct.
describe("padded ref titles", () => {
  const padded: ShownBacklinkGroup[] = [
    { page_id: pageIdOf(1), page_title: canonicalTitleOf("Daily A"), items: [
      item("p1", "about [[AI]] and [[ML]]"),
      item("p2", "padded [[ AI ]] and [[ML ]]")] },
  ];

  describe("flag on", () => {
    it("omits the page's own title however it is spelled", () => {
      expect(chipCounts(padded, [T("AI")], on).map((c) => c.title))
        .not.toContain(" AI ");
    });

    it("counts every spelling of ML as one chip", () => {
      expect(chipCounts(padded, [T("AI")], on))
        .toEqual([{ title: "ML", count: 2 }]);
    });

    it("including ML keeps the item that links [[ML ]]", () => {
      const out = applyFilter(
        padded, { include: [T("ML")], exclude: [] }, on);
      expect(out[0]?.items).toHaveLength(2);
    });

    it("excluding ML hides the item that links [[ML ]]", () => {
      expect(applyFilter(
        padded, { include: [], exclude: [T("ML")] }, on)).toEqual([]);
    });
  });

  it("an include picked under flag off still matches once the flag is on", () => {
    const stale = { include: [T("ML ")], exclude: [] };
    expect(applyFilter(padded, stale, on)[0]?.items).toHaveLength(2);
    expect(applyFilter(padded, stale, off)[0]?.items.map((i) => i.uid))
      .toEqual(["tuid-p2"]);
  });

  it("omit entries picked under flag off are re-read when the flag is on", () => {
    expect(chipCounts(padded, [T(" AI ")], on)).toEqual(
      [{ title: "ML", count: 2 }]);
  });

  describe("flag off", () => {
    it("keeps padded titles distinct, as distinct pages", () => {
      expect(chipCounts(padded, [T("AI")], off)).toEqual([
        { title: " AI ", count: 1 }, { title: "ML", count: 1 },
        { title: "ML ", count: 1 }]);
    });

    it("including ML keeps only the item that links [[ML]]", () => {
      const out = applyFilter(
        padded, { include: [T("ML")], exclude: [] }, off);
      expect(out[0]?.items.map((i) => i.uid)).toEqual(["tuid-p1"]);
    });
  });

  it("does not serve one flag value's titles to the other", () => {
    const it = item("p3", "[[ML ]]");
    expect([...itemRefTitles(it, on)]).toEqual(["ML"]);
    expect([...itemRefTitles(it, off)]).toEqual(["ML "]);
  });
});
