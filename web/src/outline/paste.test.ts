import { describe, expect, it } from "vitest";
import { isOutlinePaste, parseOutlineForest, PastedNode, planOutlinePaste } from "./paste";
import { block } from "../test-helpers";

const node = (text: string, children: PastedNode[] = []): PastedNode =>
  ({ text, children });

function uidGen() {
  let n = 0;
  return () => `n${++n}`;
}

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

const PAGE = "Page";

describe("planOutlinePaste", () => {
  it("splices the first root at the caret and creates the rest as siblings", () => {
    const blocks = [
      block("a", "hello world", { order_idx: 0 }),
      block("z", "after", { order_idx: 1 }),
    ];
    const r = planOutlinePaste(blocks, PAGE, "a", 5, 5, "X\nY\nZ", uidGen());
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "helloX world" },
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: null,
        order_idx: 1, text: "Y" },
      { op: "create", uid: "n2", page_title: PAGE, parent_uid: null,
        order_idx: 2, text: "Z" },
    ]);
    // applyOps mirror: a, Y, Z, after in order
    expect(r.blocks.map((b) => b.text)).toEqual(
      ["helloX world", "Y", "Z", "after"]);
    expect(r.focus).toEqual({ uid: "n2", cursor: 1 });
  });

  it("replaces a text selection with the first root's text", () => {
    const blocks = [block("a", "abcdef", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 1, 4, "XY\nrest", uidGen());
    expect(r.ops[0]).toEqual({ op: "update_text", uid: "a", text: "aXYef" });
  });

  it("nests pasted children under their pasted parents (depth-first creates)", () => {
    const blocks = [block("a", "", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 0, 0,
                               "top\nnext\n\tchild\n\t\tgrand", uidGen());
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "top" },
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: null,
        order_idx: 1, text: "next" },
      { op: "create", uid: "n2", page_title: PAGE, parent_uid: "n1",
        order_idx: 0, text: "child" },
      { op: "create", uid: "n3", page_title: PAGE, parent_uid: "n2",
        order_idx: 0, text: "grand" },
    ]);
    expect(r.focus).toEqual({ uid: "n3", cursor: "grand".length });
  });

  it("the first root's children become the target's FIRST children", () => {
    const blocks = [
      block("a", "parent", {
        order_idx: 0,
        children: [block("a0", "existing", { order_idx: 4 })],
      }),
    ];
    const r = planOutlinePaste(blocks, PAGE, "a", 6, 6, "!\n\tk1\n\tk2",
                               uidGen());
    expect(r.ops).toEqual([
      { op: "update_text", uid: "a", text: "parent!" },
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: "a",
        order_idx: 4, text: "k1" },
      { op: "create", uid: "n2", page_title: PAGE, parent_uid: "a",
        order_idx: 5, text: "k2" },
    ]);
    const a = r.blocks[0];
    expect(a.children.map((c) => c.text)).toEqual(["k1", "k2", "existing"]);
  });

  it("expands a collapsed target that receives children", () => {
    const blocks = [
      block("a", "p", {
        order_idx: 0, collapsed: true,
        children: [block("a0", "hidden", { order_idx: 0 })],
      }),
    ];
    // first root "!" carries a child, so the collapsed target must expand
    const r = planOutlinePaste(blocks, PAGE, "a", 1, 1, "!\n\tkid", uidGen());
    expect(r.ops[0]).toEqual({ op: "update_text", uid: "a", text: "p!" });
    expect(r.ops).toContainEqual({ op: "set_collapsed", uid: "a",
                                   collapsed: false });
  });

  it("sibling roots insert between the target and its next sibling", () => {
    const blocks = [
      block("p", "P", {
        order_idx: 0,
        children: [
          block("p0", "first", { order_idx: 2 }),
          block("p1", "second", { order_idx: 7 }),
        ],
      }),
    ];
    const r = planOutlinePaste(blocks, PAGE, "p0", 0, 5, "first\nmid",
                               uidGen());
    // splice replaces "first" with "first": no update_text op is emitted
    expect(r.ops).toEqual([
      { op: "create", uid: "n1", page_title: PAGE, parent_uid: "p",
        order_idx: 7, text: "mid" },
    ]);
    expect(r.blocks[0].children.map((c) => c.text))
      .toEqual(["first", "mid", "second"]);
  });

  it("single root with no children: splice only, focus after the pasted text", () => {
    const blocks = [block("a", "ab", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 1, 1, "XY\n", uidGen());
    expect(r.ops).toEqual([{ op: "update_text", uid: "a", text: "aXYb" }]);
    expect(r.focus).toEqual({ uid: "a", cursor: 3 });
  });

  it("clamps out-of-range caret offsets", () => {
    const blocks = [block("a", "ab", { order_idx: 0 })];
    const r = planOutlinePaste(blocks, PAGE, "a", 99, 99, "X\nY", uidGen());
    expect(r.ops[0]).toEqual({ op: "update_text", uid: "a", text: "abX" });
  });

  it("no-ops on a missing uid or an empty parse", () => {
    const blocks = [block("a", "ab", { order_idx: 0 })];
    expect(planOutlinePaste(blocks, PAGE, "gone", 0, 0, "x\ny", uidGen()).ops)
      .toEqual([]);
    expect(planOutlinePaste(blocks, PAGE, "a", 0, 0, " \n ", uidGen()).ops)
      .toEqual([]);
  });
});
