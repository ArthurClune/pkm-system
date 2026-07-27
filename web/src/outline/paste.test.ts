import { describe, expect, it } from "vitest";
import { isOutlinePaste, parseOutlineForest, PastedNode } from "./paste";

const node = (text: string, children: PastedNode[] = []): PastedNode =>
  ({ text, children });

describe("parseOutlineForest", () => {
  it("tab indentation nests children under the previous shallower line", () => {
    expect(parseOutlineForest("a\n\tb\n\t\tc\n\td\ne")).toEqual([
      node("a", [node("b", [node("c")]), node("d")]),
      node("e"),
    ]);
  });

  it("2-space and 4-space indents both work without configuration", () => {
    expect(parseOutlineForest("a\n  b\n    c")).toEqual([
      node("a", [node("b", [node("c")])]),
    ]);
    expect(parseOutlineForest("a\n    b\n        c")).toEqual([
      node("a", [node("b", [node("c")])]),
    ]);
  });

  it("mixed tab and space indents compare by column width (tab = 4)", () => {
    // "\t" (4 cols) deeper than "  " (2 cols)
    expect(parseOutlineForest("a\n  b\n\tc")).toEqual([
      node("a", [node("b", [node("c")])]),
    ]);
  });

  it("equal widths are siblings; dedent returns to the matching level", () => {
    expect(parseOutlineForest("a\n\tb\n\tc\nd")).toEqual([
      node("a", [node("b"), node("c")]),
      node("d"),
    ]);
  });

  it("an over-indent jump of any size is exactly one level deeper", () => {
    expect(parseOutlineForest("a\n\t\t\tb\n\tc")).toEqual([
      node("a", [node("b"), node("c")]),
    ]);
  });

  it("a dedent to a never-seen width becomes a sibling of the nearest shallower level", () => {
    // widths 0, 4; then 2 pops the 4-level and lands under the 0-level
    expect(parseOutlineForest("a\n    b\n  c")).toEqual([
      node("a", [node("b"), node("c")]),
    ]);
  });

  it("a uniformly indented clipboard still starts at depth 0", () => {
    expect(parseOutlineForest("\t\ta\n\t\t\tb")).toEqual([
      node("a", [node("b")]),
    ]);
  });

  it("blank lines never create blocks", () => {
    expect(parseOutlineForest("a\n\n   \n\tb")).toEqual([
      node("a", [node("b")]),
    ]);
  });

  it("CRLF and CR normalize to LF", () => {
    expect(parseOutlineForest("a\r\n\tb\rc")).toEqual([
      node("a", [node("b")]), node("c"),
    ]);
  });

  it("strips - * + bullets only when every line has one", () => {
    expect(parseOutlineForest("- a\n\t* b\n\t+ c")).toEqual([
      node("a", [node("b"), node("c")]),
    ]);
    // one bulletless line -> everything verbatim
    expect(parseOutlineForest("- a\nplain")).toEqual([
      node("- a"), node("plain"),
    ]);
  });

  it("numbered lists paste literally", () => {
    expect(parseOutlineForest("1. a\n2. b")).toEqual([
      node("1. a"), node("2. b"),
    ]);
  });

  it("keeps inline content verbatim", () => {
    expect(parseOutlineForest("x [[Ref]] #tag\n\t{{[[TODO]]}} y")).toEqual([
      node("x [[Ref]] #tag", [node("{{[[TODO]]}} y")]),
    ]);
  });

  it("returns [] for empty or blank-only text", () => {
    expect(parseOutlineForest("")).toEqual([]);
    expect(parseOutlineForest(" \n\t\n")).toEqual([]);
  });
});

describe("isOutlinePaste", () => {
  it("true for multi-line text (including a single line with trailing newline)", () => {
    expect(isOutlinePaste("a\nb")).toBe(true);
    expect(isOutlinePaste("a\n")).toBe(true);
    expect(isOutlinePaste("a\r\nb")).toBe(true);
  });

  it("false for single-line or blank-only text", () => {
    expect(isOutlinePaste("just one line")).toBe(false);
    expect(isOutlinePaste("")).toBe(false);
    expect(isOutlinePaste("\n \n")).toBe(false);
  });
});
