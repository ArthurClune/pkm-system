import { describe, it, expect } from "vitest";
import { autoPairBracket, wrapLink } from "./keyEdits";

describe("autoPairBracket", () => {
  it("auto-closes an opening bracket with the caret inside", () => {
    expect(autoPairBracket("", 0, 0, "[")).toEqual({ text: "[]", selStart: 1, selEnd: 1 });
    expect(autoPairBracket("", 0, 0, "(")).toEqual({ text: "()", selStart: 1, selEnd: 1 });
    expect(autoPairBracket("", 0, 0, "{")).toEqual({ text: "{}", selStart: 1, selEnd: 1 });
  });

  it("auto-closes symmetric characters", () => {
    expect(autoPairBracket("", 0, 0, "`")).toEqual({ text: "``", selStart: 1, selEnd: 1 });
    expect(autoPairBracket("", 0, 0, '"')).toEqual({ text: '""', selStart: 1, selEnd: 1 });
    expect(autoPairBracket("", 0, 0, "'")).toEqual({ text: "''", selStart: 1, selEnd: 1 });
  });

  it("inserts the pair at an interior caret", () => {
    // "ab|cd" typing "(" -> "ab(|)cd"
    expect(autoPairBracket("abcd", 2, 2, "(")).toEqual({ text: "ab()cd", selStart: 3, selEnd: 3 });
  });

  it("wraps a selection and keeps the inner text selected", () => {
    // select "foo" in "foo" typing "[" -> "[foo]" with foo selected (1..4)
    expect(autoPairBracket("foo", 0, 3, "[")).toEqual({ text: "[foo]", selStart: 1, selEnd: 4 });
    // interior selection: "a bcd e" select "bcd" (2..5) typing "`"
    expect(autoPairBracket("a bcd e", 2, 5, "`")).toEqual({
      text: "a `bcd` e", selStart: 3, selEnd: 6,
    });
  });

  it("composes into the [[ page-link trigger when [ is typed twice", () => {
    // start "[]" caret at 1, type "[" -> "[[]]" caret at 2
    expect(autoPairBracket("[]", 1, 1, "[")).toEqual({ text: "[[]]", selStart: 2, selEnd: 2 });
  });

  it("skips over a closing bracket that matches the next char", () => {
    // "[]" caret at 1, type "]" -> caret moves to 2, text unchanged
    expect(autoPairBracket("[]", 1, 1, "]")).toEqual({ text: "[]", selStart: 2, selEnd: 2 });
    expect(autoPairBracket("()", 1, 1, ")")).toEqual({ text: "()", selStart: 2, selEnd: 2 });
    expect(autoPairBracket("{}", 1, 1, "}")).toEqual({ text: "{}", selStart: 2, selEnd: 2 });
  });

  it("skips over a symmetric char that matches the next char", () => {
    expect(autoPairBracket('""', 1, 1, '"')).toEqual({ text: '""', selStart: 2, selEnd: 2 });
    expect(autoPairBracket("``", 1, 1, "`")).toEqual({ text: "``", selStart: 2, selEnd: 2 });
  });

  it("does not auto-pair a quote that abuts a word (apostrophe)", () => {
    // "don" caret 3, type "'" -> null (let it insert a plain apostrophe)
    expect(autoPairBracket("don", 3, 3, "'")).toBeNull();
    expect(autoPairBracket("it", 2, 2, "'")).toBeNull();
  });

  it("still auto-pairs a quote after whitespace or at the start", () => {
    expect(autoPairBracket("say ", 4, 4, '"')).toEqual({ text: 'say ""', selStart: 5, selEnd: 5 });
  });

  it("returns null for a lone closing bracket with no match ahead", () => {
    expect(autoPairBracket("ab", 2, 2, "]")).toBeNull();
    expect(autoPairBracket("ab", 1, 1, ")")).toBeNull();
  });

  it("returns null for a non-bracket character", () => {
    expect(autoPairBracket("ab", 2, 2, "a")).toBeNull();
  });
});

describe("wrapLink", () => {
  it("wraps a selection as [sel]() with the caret between the parens", () => {
    // "foo" fully selected -> "[foo]()" caret at index 6
    expect(wrapLink("foo", 0, 3)).toEqual({ text: "[foo]()", selStart: 6, selEnd: 6 });
  });

  it("wraps an interior selection", () => {
    // "ab cd ef" select "cd" (3..5) -> "ab [cd]() ef", caret after "(" = 8
    expect(wrapLink("ab cd ef", 3, 5)).toEqual({
      text: "ab [cd]() ef", selStart: 8, selEnd: 8,
    });
  });

  it("inserts an empty []() with the caret between the brackets when nothing is selected", () => {
    expect(wrapLink("", 0, 0)).toEqual({ text: "[]()", selStart: 1, selEnd: 1 });
    // interior caret in "abcd" at 2
    expect(wrapLink("abcd", 2, 2)).toEqual({ text: "ab[]()cd", selStart: 3, selEnd: 3 });
  });
});
