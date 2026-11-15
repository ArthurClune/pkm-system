import { describe, expect, it } from "vitest";
import { matchesFilter, parseFilter } from "./filter";

const COLUMNS = ["Title", "Source", "Format", "Reading Status", "Author"];
const row = (over: Record<string, string>) => ({
  Title: "Take Smart Notes",
  Source: "Books",
  Format: "Kindle",
  "Reading Status": "Reading",
  Author: "[[Quinn Slobodian]]",
  ...over,
});
const hit = (r: Record<string, string>, text: string) =>
  matchesFilter(r, parseFilter(text), COLUMNS);

describe("parseFilter", () => {
  it("reads words, columns, negation and phrases", () => {
    expect(parseFilter('a -b status:read -x:y "t s" c:"p q" s:')).toEqual([
      { neg: false, col: null, value: "a" },
      { neg: true, col: null, value: "b" },
      { neg: false, col: "status", value: "read" },
      { neg: true, col: "x", value: "y" },
      { neg: false, col: null, value: "t s" },
      { neg: false, col: "c", value: "p q" },
      { neg: false, col: "s", value: "" },
    ]);
  });

  it("treats a lone dash and an unclosed quote as literal text", () => {
    expect(parseFilter("-")).toEqual([{ neg: false, col: null, value: "-" }]);
    expect(parseFilter('"take sm')).toEqual([
      { neg: false, col: null, value: "take sm" },
    ]);
    expect(parseFilter("")).toEqual([]);
  });
});

describe("matchesFilter", () => {
  it("a plain word matches a word start in any column", () => {
    expect(hit(row({}), "kind")).toBe(true);
    expect(hit(row({ Format: "Unread" }), "read")).toBe(true);
    expect(hit(row({ Format: "Unread", "Reading Status": "" }), "read")).toBe(
      false,
    );
    expect(hit(row({}), "KINDLE")).toBe(true);
  });

  it("a plain word searches title and source too", () => {
    expect(hit(row({}), "books")).toBe(true);
    expect(hit(row({}), "notes")).toBe(true);
  });

  it("col:value looks only in columns with a word starting col", () => {
    const r = row({ Format: "Read" });
    expect(hit(r, "status:read")).toBe(true);
    expect(hit(row({ Format: "Read", "Reading Status": "Unread" }), "status:read"))
      .toBe(false);
    expect(hit(row({ "Reading Status": "Unread" }), "status:read")).toBe(false);
  });

  it("-col:value keeps blank and Unread, drops Read", () => {
    for (const [cell, keep] of [["", true], ["Unread", true], ["Read", false]] as const) {
      expect(hit(row({ "Reading Status": cell }), "-status:read")).toBe(keep);
    }
  });

  it("col: matches empty cells only; -col: non-empty", () => {
    expect(hit(row({ "Reading Status": "" }), "status:")).toBe(true);
    expect(hit(row({ "Reading Status": "  " }), "status:")).toBe(true);
    expect(hit(row({}), "status:")).toBe(false);
    expect(hit(row({}), "-status:")).toBe(true);
    const missing: Record<string, string> = row({});
    delete missing["Reading Status"];
    expect(hit(missing, "status:")).toBe(true);
  });

  it("a col whose prefix names no column matches nothing", () => {
    expect(hit(row({}), "nope:x")).toBe(false);
    expect(hit(row({}), "-nope:x")).toBe(true);
    expect(hit(row({}), "nope:")).toBe(false);
  });

  it("a quoted phrase matches consecutive word starts", () => {
    expect(hit(row({}), '"take smart"')).toBe(true);
    expect(hit(row({}), '"tak sm no"')).toBe(true);
    expect(hit(row({}), '"smart take"')).toBe(false);
    expect(hit(row({}), '"take notes"')).toBe(false);
  });

  it("ignores # and [[ ]] markup", () => {
    expect(hit(row({}), "author:slobodian")).toBe(true);
    expect(hit(row({ Title: "#[[Big Idea]]" }), "big")).toBe(true);
    expect(hit(row({ Title: "see ((abc))" }), "abc")).toBe(true);
  });

  it("source: uses the Source column", () => {
    expect(hit(row({ Source: "unlinked" }), "source:unlinked")).toBe(true);
    expect(hit(row({ Source: "page" }), "source:unlinked")).toBe(false);
  });

  it("all terms must hold", () => {
    expect(hit(row({}), "kind -status:done")).toBe(true);
    expect(hit(row({}), "kind zzz")).toBe(false);
    expect(hit(row({}), "")).toBe(true);
  });

  it("a lone dash does not throw and matches", () => {
    expect(hit(row({}), "-")).toBe(true);
  });
});
