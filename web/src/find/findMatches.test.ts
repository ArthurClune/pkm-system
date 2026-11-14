import { describe, expect, it } from "vitest";
import {
  clampIndex,
  findCommand,
  findMatches,
  stepIndex,
} from "./findMatches";

describe("findMatches", () => {
  it("is case-insensitive", () => {
    expect(findMatches([["Hello hello"]], "HELLO")).toEqual([
      { group: 0, start: { node: 0, offset: 0 }, end: { node: 0, offset: 5 } },
      { group: 0, start: { node: 0, offset: 6 }, end: { node: 0, offset: 11 } },
    ]);
  });
  it("folds case outside ASCII", () => {
    expect(findMatches([["école"]], "ÉCOLE")).toHaveLength(1);
  });
  it("treats the query as literal text", () => {
    expect(findMatches([["axb a.b (x $5"]], "a.b")).toHaveLength(1);
    expect(findMatches([["(x"]], "(x")).toHaveLength(1);
    expect(findMatches([["$5"]], "$5")).toHaveLength(1);
  });
  it("does not overlap matches", () => {
    expect(findMatches([["aaa"]], "aa")).toHaveLength(1);
  });
  it("matches across nodes of one group", () => {
    expect(findMatches([["foo ba", "r baz"]], "bar")).toEqual([
      { group: 0, start: { node: 0, offset: 4 }, end: { node: 1, offset: 1 } },
    ]);
  });
  it("ends a match at the end of its node, not the start of the next", () => {
    expect(findMatches([["foo", "bar"]], "foo")[0].end)
      .toEqual({ node: 0, offset: 3 });
  });
  it("never matches across groups", () => {
    expect(findMatches([["foo"], ["bar"]], "foobar")).toEqual([]);
  });
  it("returns nothing for an empty query", () => {
    expect(findMatches([["abc"]], "")).toEqual([]);
  });
});

describe("stepIndex", () => {
  it("starts at the first or last match", () => {
    expect(stepIndex(null, 3, 1)).toBe(0);
    expect(stepIndex(null, 3, -1)).toBe(2);
  });
  it("wraps both ways", () => {
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });
  it("is null with no matches", () => {
    expect(stepIndex(1, 0, 1)).toBeNull();
  });
});

describe("clampIndex", () => {
  it("keeps an index that still exists", () => expect(clampIndex(1, 3)).toBe(1));
  it("falls back to the first match", () => expect(clampIndex(5, 3)).toBe(0));
  it("is null with no matches", () => expect(clampIndex(0, 0)).toBeNull());
  it("selects the first match when nothing was current", () =>
    expect(clampIndex(null, 2)).toBe(0));
});

describe("findCommand", () => {
  const k = (key: string, mods: Partial<Record<
    "metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
    ({ key, metaKey: false, ctrlKey: false, altKey: false,
       shiftKey: false, ...mods });
  it("maps the chords", () => {
    expect(findCommand(k("f", { metaKey: true }))).toBe("open");
    expect(findCommand(k("g", { metaKey: true }))).toBe("next");
    expect(findCommand(k("G", { metaKey: true, shiftKey: true }))).toBe("prev");
    expect(findCommand(k("g", { metaKey: true, shiftKey: true }))).toBe("prev");
  });
  it("leaves Ctrl and Alt chords alone", () => {
    expect(findCommand(k("f", { ctrlKey: true }))).toBeNull();
    expect(findCommand(k("f", { metaKey: true, ctrlKey: true }))).toBeNull();
    expect(findCommand(k("f", { metaKey: true, altKey: true }))).toBeNull();
    expect(findCommand(k("f"))).toBeNull();
  });
  it("ignores Shift-Cmd-F", () => {
    expect(findCommand(k("F", { metaKey: true, shiftKey: true }))).toBeNull();
  });
});
