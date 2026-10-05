import { describe, expect, it } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import type { PastedNode } from "../../outline/paste";
import { expectedRows } from "./model";
import { readingRows, type Row } from "./reading";
import type { Resolved } from "./run";

type Over = Partial<Omit<BlockNode, "uid" | "children" | "order_idx">>;

/** A block whose text is its uid unless overridden; children in order. */
const t = (uid: string, ...rest: (BlockNode | Over)[]): BlockNode => {
  const over = rest.find((x): x is Over => !("uid" in x)) ?? {};
  const children = rest.filter((x): x is BlockNode => "uid" in x)
    .map((c, i) => ({ ...c, order_idx: i as OrderIdx }));
  return {
    uid: uid as BlockUid, text: uid, heading: null, view_type: null, collapsed: false,
    order_idx: 0 as OrderIdx, created_at: null, updated_at: null, ...over, children,
  };
};

const page = (...roots: BlockNode[]): Row[] =>
  readingRows(roots.map((r, i) => ({ ...r, order_idx: i as OrderIdx })));

const u = (s: string): BlockUid => s as BlockUid;
const us = (...s: string[]): BlockUid[] => s.map(u);
const rows = (...roots: BlockNode[]) => ({ kind: "rows", rows: page(...roots) });
const noop = { kind: "noop" };

describe("type", () => {
  it("replaces the row's text; the same text is a noop", () => {
    const before = page(t("a", t("b")));
    expect(expectedRows(before, { kind: "type", uid: u("b"), text: "new" }))
      .toEqual(rows(t("a", t("b", { text: "new" }))));
    expect(expectedRows(before, { kind: "type", uid: u("b"), text: "b" })).toEqual(noop);
  });
});

describe("split", () => {
  it("split mid-text with visible children makes the first child", () => {
    const before = page(t("a", { text: "hello" }, t("b"), t("c")), t("d"));
    expect(expectedRows(before, { kind: "split", uid: u("a"), caret: 2, fresh: u("n") }))
      .toEqual(rows(t("a", { text: "he" }, t("n", { text: "llo" }), t("b"), t("c")), t("d")));
  });

  it("split at caret 0 inserts an empty row above", () => {
    const before = page(t("p", t("a", t("b"))));
    expect(expectedRows(before, { kind: "split", uid: u("a"), caret: 0, fresh: u("n") }))
      .toEqual(rows(t("p", t("n", { text: "" }), t("a", t("b")))));
  });

  it("split of a collapsed parent goes after its hidden subtree", () => {
    const before = page(t("a", { text: "ab", collapsed: true, heading: 2 }, t("b", t("c"))), t("d"));
    expect(expectedRows(before, { kind: "split", uid: u("a"), caret: 1, fresh: u("n") }))
      .toEqual(rows(
        t("a", { text: "a", collapsed: true, heading: 2 }, t("b", t("c"))),
        t("n", { text: "b" }),
        t("d"),
      ));
  });

  it("split at the end of a childless row adds an empty next sibling", () => {
    const before = page(t("a"), t("b"));
    expect(expectedRows(before, { kind: "split", uid: u("a"), caret: 1, fresh: u("n") }))
      .toEqual(rows(t("a"), t("n", { text: "" }), t("b")));
  });
});

describe("backspace", () => {
  it("backspace merges into a childless previous sibling", () => {
    const before = page(t("p", t("a", { text: "foo", heading: 1 }), t("b", { text: "bar" }), t("c")));
    expect(expectedRows(before, { kind: "backspace", uid: u("b") }))
      .toEqual(rows(t("p", t("a", { text: "foobar", heading: 1 }), t("c"))));
  });

  it("backspace on a first sibling deletes only when empty", () => {
    const empty = page(t("p", t("a", { text: "" }), t("b")));
    expect(expectedRows(empty, { kind: "backspace", uid: u("a") }))
      .toEqual(rows(t("p", t("b"))));
    const full = page(t("p", t("a"), t("b")));
    expect(expectedRows(full, { kind: "backspace", uid: u("a") })).toEqual(noop);
  });

  it("backspace after a previous sibling with children deletes only when empty", () => {
    const empty = page(t("a", t("a1")), t("b", { text: "" }));
    expect(expectedRows(empty, { kind: "backspace", uid: u("b") })).toEqual(rows(t("a", t("a1"))));
    const full = page(t("a", t("a1")), t("b"));
    expect(expectedRows(full, { kind: "backspace", uid: u("b") })).toEqual(noop);
  });

  it("backspace on a row with children is a noop, even when they are hidden", () => {
    const before = page(t("a"), t("b", { text: "", collapsed: true }, t("c")));
    expect(expectedRows(before, { kind: "backspace", uid: u("b") })).toEqual(noop);
  });
});

describe("indent", () => {
  it("indent of a first sibling is a noop", () => {
    const before = page(t("p", t("a"), t("b")));
    expect(expectedRows(before, { kind: "indent", uid: u("a") })).toEqual(noop);
    expect(expectedRows(before, { kind: "indent", uid: u("p") })).toEqual(noop);
  });

  it("indent expands a collapsed new parent", () => {
    const before = page(t("a", { collapsed: true }, t("x")), t("b", t("c")));
    expect(expectedRows(before, { kind: "indent", uid: u("b") }))
      .toEqual(rows(t("a", t("x"), t("b", t("c")))));
  });

  it("indentSel with two runs under different parents", () => {
    const before = page(t("a", t("a1"), t("a2"), t("a3")), t("b"), t("c"));
    const r: Resolved = { kind: "indentSel", uids: us("a2", "a3", "b", "c") };
    expect(expectedRows(before, r))
      .toEqual(rows(t("a", t("a1", t("a2"), t("a3")), t("b"), t("c"))));
  });

  it("indentSel is a noop when any run starts at a first sibling", () => {
    const before = page(t("a", t("a1"), t("a2")), t("b"));
    const r: Resolved = { kind: "indentSel", uids: us("a1", "a2", "b") };
    expect(expectedRows(before, r)).toEqual(noop);
  });
});

describe("outdent", () => {
  it("outdent adopts the following siblings and keeps their depth", () => {
    const before = page(
      t("p", t("a"), t("b", { collapsed: true }, t("b1")), t("c"), t("d", t("d1"))),
      t("q"),
    );
    expect(expectedRows(before, { kind: "outdent", uid: u("b") }))
      .toEqual(rows(t("p", t("a")), t("b", t("b1"), t("c"), t("d", t("d1"))), t("q")));
  });

  it("outdent of a last sibling adopts nothing and stays collapsed", () => {
    const before = page(t("p", t("a"), t("b", { collapsed: true }, t("b1"))));
    expect(expectedRows(before, { kind: "outdent", uid: u("b") }))
      .toEqual(rows(t("p", t("a")), t("b", { collapsed: true }, t("b1"))));
  });

  it("outdent at top level is a noop", () => {
    expect(expectedRows(page(t("a"), t("b")), { kind: "outdent", uid: u("b") })).toEqual(noop);
  });

  it("outdentSel two runs: only the last adopts, up to the end of its sibling list", () => {
    // Runs [a2] under a and [b] under p: a2 has no later sibling to adopt; b
    // adopts c and d, up to the end of p's children, and q stays top-level.
    // A contiguous selection never holds two runs under one parent, so the
    // "up to the next run under the same parent" bound is not reachable here.
    const before = page(
      t("p", t("a", t("a1"), t("a2")), t("b", { collapsed: true }, t("b1")), t("c"), t("d")),
      t("q"),
    );
    const r: Resolved = { kind: "outdentSel", uids: us("a2", "b") };
    expect(expectedRows(before, r)).toEqual(rows(
      t("p", t("a", t("a1")), t("a2")),
      t("b", t("b1"), t("c"), t("d")),
      t("q"),
    ));
  });

  it("outdentSel is a noop when any run is top-level", () => {
    const before = page(t("a", t("a1")), t("b"));
    const r: Resolved = { kind: "outdentSel", uids: us("a1", "b") };
    expect(expectedRows(before, r)).toEqual(noop);
  });
});

describe("deleteSel", () => {
  it("deleteSel of a parent and its child removes the parent's subtree once", () => {
    const before = page(t("a", t("b", t("c")), t("d")), t("e"));
    expect(expectedRows(before, { kind: "deleteSel", uids: us("b", "c") }))
      .toEqual(rows(t("a", t("d")), t("e")));
  });

  it("deleteSel takes a selected collapsed row's hidden subtree with it", () => {
    const before = page(t("a", t("b", { collapsed: true }, t("c")), t("d")), t("e"));
    expect(expectedRows(before, { kind: "deleteSel", uids: us("b", "d") }))
      .toEqual(rows(t("a"), t("e")));
  });
});

describe("selection inputs", () => {
  it("a selection naming a row the page lacks throws", () => {
    const before = page(t("a"), t("b"));
    expect(() => expectedRows(before, { kind: "deleteSel", uids: us("a", "x") }))
      .toThrow("model: no row x");
    expect(() => expectedRows(before, { kind: "indentSel", uids: us("x") }))
      .toThrow("model: no row x");
  });
});

describe("fields", () => {
  it("heading set to its current value is a noop", () => {
    const before = page(t("a", { heading: 2 }));
    expect(expectedRows(before, { kind: "heading", uid: u("a"), value: 2 })).toEqual(noop);
    expect(expectedRows(before, { kind: "heading", uid: u("a"), value: null }))
      .toEqual(rows(t("a")));
  });

  it("collapse hides the row's subtree; uncollapsing an expanded row is a noop", () => {
    const before = page(t("a", t("b", t("c"))));
    expect(expectedRows(before, { kind: "collapse", uid: u("b"), value: true }))
      .toEqual(rows(t("a", t("b", { collapsed: true }, t("c")))));
    expect(expectedRows(before, { kind: "collapse", uid: u("b"), value: false })).toEqual(noop);
  });

  it("view type: the same value is a noop", () => {
    const numbered = page(t("a", { view_type: "numbered" }));
    expect(expectedRows(numbered, { kind: "viewType", uid: u("a"), value: "numbered" })).toEqual(noop);
    expect(expectedRows(numbered, { kind: "viewType", uid: u("a"), value: "document" }))
      .toEqual(rows(t("a", { view_type: "document" })));
  });

  it("view type: document over null is a noop, since null reads as document", () => {
    expect(expectedRows(page(t("a")), { kind: "viewType", uid: u("a"), value: "document" }))
      .toEqual(noop);
  });

  it("view type: numbered over null is a change", () => {
    expect(expectedRows(page(t("a")), { kind: "viewType", uid: u("a"), value: "numbered" }))
      .toEqual(rows(t("a", { view_type: "numbered" })));
  });
});

describe("move", () => {
  it("moveDown swaps whole subtrees", () => {
    const before = page(t("a", t("a1")), t("b", t("b1"), t("b2")), t("c"));
    expect(expectedRows(before, { kind: "moveDown", uid: u("a") }))
      .toEqual(rows(t("b", t("b1"), t("b2")), t("a", t("a1")), t("c")));
    expect(expectedRows(before, { kind: "moveUp", uid: u("b") }))
      .toEqual(rows(t("b", t("b1"), t("b2")), t("a", t("a1")), t("c")));
  });

  it("moveUp of a first child stays inside its parent", () => {
    const before = page(t("u"), t("p", t("x"), t("y")));
    expect(expectedRows(before, { kind: "moveUp", uid: u("x") })).toEqual(noop);
    expect(expectedRows(before, { kind: "moveDown", uid: u("y") })).toEqual(noop);
  });

  it("subtreeUp at a first child becomes the previous uncle's last child and expands it", () => {
    const before = page(t("u", { collapsed: true }, t("u1")), t("p", t("x", t("x1")), t("y")));
    expect(expectedRows(before, { kind: "subtreeUp", uid: u("x") }))
      .toEqual(rows(t("u", t("u1"), t("x", t("x1"))), t("p", t("y"))));
  });

  it("subtreeDown at a last child becomes the next uncle's first child and expands it", () => {
    const before = page(t("p", t("x"), t("y", t("y1"))), t("u", { collapsed: true }, t("u1")));
    expect(expectedRows(before, { kind: "subtreeDown", uid: u("y") }))
      .toEqual(rows(t("p", t("x")), t("u", t("y", t("y1")), t("u1"))));
  });

  it("subtreeDown at the last top-level row is a noop", () => {
    const before = page(t("a"), t("b", t("b1")));
    expect(expectedRows(before, { kind: "subtreeDown", uid: u("b") })).toEqual(noop);
    // b1's parent b has no next sibling to cross into.
    expect(expectedRows(before, { kind: "subtreeDown", uid: u("b1") })).toEqual(noop);
  });

  it("subtreeUp with a previous sibling swaps like moveUp", () => {
    const before = page(t("a"), t("b", t("b1")));
    expect(expectedRows(before, { kind: "subtreeUp", uid: u("b") }))
      .toEqual(rows(t("b", t("b1")), t("a")));
  });
});

describe("move selection", () => {
  it("selUp two runs under different parents", () => {
    // [g] has no sibling above, so it crosses into c0 (expanded); [c2] then
    // swaps with c1, which g has left.
    const before = page(t("a", t("c0", { collapsed: true }, t("c00")), t("c1", t("g")), t("c2")));
    const r: Resolved = { kind: "selUp", uids: us("g", "c2") };
    expect(expectedRows(before, r))
      .toEqual(rows(t("a", t("c0", t("c00"), t("g")), t("c2"), t("c1"))));
  });

  it("selUp swaps each run with the sibling above it", () => {
    const before = page(t("a", t("c0"), t("c1", t("g0"), t("g")), t("c2")));
    const r: Resolved = { kind: "selUp", uids: us("g", "c2") };
    expect(expectedRows(before, r))
      .toEqual(rows(t("a", t("c0"), t("c2"), t("c1", t("g"), t("g0")))));
  });

  it("selDown blocked run makes the gesture a noop", () => {
    // [a2] could cross into b, but [b] is the last top-level row.
    const before = page(t("a", t("a1"), t("a2")), t("b"));
    const r: Resolved = { kind: "selDown", uids: us("a2", "b") };
    expect(expectedRows(before, r)).toEqual(noop);
  });

  it("selDown crossing into a selected root leaves it collapsed", () => {
    const before = page(t("a", t("a1"), t("a2")), t("b", { collapsed: true }, t("b1")), t("c"));
    const r: Resolved = { kind: "selDown", uids: us("a2", "b") };
    expect(expectedRows(before, r))
      .toEqual(rows(t("a", t("a1")), t("c"), t("b", { collapsed: true }, t("a2"), t("b1"))));
  });

  it("selDown moves a run of adjacent siblings as one block", () => {
    const before = page(t("a"), t("b", t("b1")), t("c"));
    const r: Resolved = { kind: "selDown", uids: us("a", "b", "b1") };
    expect(expectedRows(before, r)).toEqual(rows(t("c"), t("a"), t("b", t("b1"))));
  });
});

describe("drop", () => {
  const drop = (uids: BlockUid[], boundary: number, depth: number): Resolved =>
    ({ kind: "drop", uids, position: { boundary, depth } });

  it("drop after a collapsed row lands after its hidden children", () => {
    const before = page(t("a", { collapsed: true }, t("a1")), t("b"), t("c"));
    expect(expectedRows(before, drop(us("c"), 1, 0)))
      .toEqual(rows(t("a", { collapsed: true }, t("a1")), t("c"), t("b")));
  });

  it("drop at the end appends at the chosen depth", () => {
    const before = page(t("a", t("a1")), t("b", t("b1")), t("c"));
    // Without a's subtree the rows are b, b1, c; boundary 3 is after c.
    expect(expectedRows(before, drop(us("a"), 3, 1)))
      .toEqual(rows(t("b", t("b1")), t("c", t("a", t("a1")))));
  });

  it("drop back where it was is a noop", () => {
    const before = page(t("a"), t("b", t("b1")), t("c"));
    expect(expectedRows(before, drop(us("b"), 1, 0))).toEqual(noop);
  });

  it("drop of two roots lands them as one run in their order", () => {
    const before = page(t("a"), t("b"), t("c", t("c1")), t("d"));
    // Without a and c the rows are b, d; boundary 2 is after d.
    expect(expectedRows(before, drop(us("a", "c"), 2, 0)))
      .toEqual(rows(t("b"), t("d"), t("a"), t("c", t("c1"))));
  });
});

describe("paste", () => {
  const node = (text: string, ...children: PastedNode[]): PastedNode => ({ text, children });

  it("paste splices the first root and nests its children first", () => {
    const before = page(t("a", { text: "hello", collapsed: true }, t("a1")), t("b"));
    const r: Resolved = {
      kind: "paste", uid: u("a"), from: 1, to: 3, text: "",
      forest: [node("XY", node("k", node("k1")), node("m"))], fresh: us("n1", "n2", "n3"),
    };
    expect(expectedRows(before, r)).toEqual(rows(
      t("a", { text: "hXYlo" },
        t("n1", { text: "k" }, t("n2", { text: "k1" })), t("n3", { text: "m" }), t("a1")),
      t("b"),
    ));
  });

  it("paste later roots follow the row's subtree", () => {
    const before = page(t("a", { text: "ab", collapsed: true }, t("a1")), t("b"));
    const r: Resolved = {
      kind: "paste", uid: u("a"), from: 1, to: 1, text: "",
      forest: [node("X"), node("Y", node("Y1")), node("Z")], fresh: us("n1", "n2", "n3"),
    };
    expect(expectedRows(before, r)).toEqual(rows(
      t("a", { text: "aXb", collapsed: true }, t("a1")),
      t("n1", { text: "Y" }, t("n2", { text: "Y1" })),
      t("n3", { text: "Z" }),
      t("b"),
    ));
  });
});
