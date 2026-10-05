import { describe, expect, it } from "vitest";
import type { BlockUid, OrderIdx } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
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

  it("outdentSel two runs adopt up to the next run", () => {
    // Runs [a2] under a and [b] under p: a2 has no later sibling to adopt; b
    // adopts c and d, up to the end of p's children, and q stays top-level.
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

  it("view type: the same value is a noop; document over null is a change", () => {
    const numbered = page(t("a", { view_type: "numbered" }));
    expect(expectedRows(numbered, { kind: "viewType", uid: u("a"), value: "numbered" })).toEqual(noop);
    expect(expectedRows(page(t("a")), { kind: "viewType", uid: u("a"), value: "document" }))
      .toEqual(rows(t("a", { view_type: "document" })));
  });
});

describe("not yet modelled", () => {
  it("throws for the move, drop and paste kinds", () => {
    const before = page(t("a"));
    expect(() => expectedRows(before, { kind: "moveUp", uid: u("a") }))
      .toThrow("model: moveUp not yet modelled");
    expect(() => expectedRows(before, { kind: "selDown", uids: us("a") }))
      .toThrow("model: selDown not yet modelled");
  });
});
