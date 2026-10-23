import { describe, expect, it } from "vitest";
import { block, orderIdxOf, canonicalTitleOf, uidOf } from "../test-helpers";
import type { BlockUid } from "../api/brands";
import { fileDropNotice, isUploadableType, partitionUploadable, planFileDropBlocks,
         planUploadBlocks, uploadableDrag } from "./fileDrop";

const file = (name: string, type: string) => new File(["x"], name, { type });

describe("isUploadableType", () => {
  it("accepts images and PDFs only", () => {
    expect(isUploadableType("image/png")).toBe(true);
    expect(isUploadableType("image/svg+xml")).toBe(true);
    expect(isUploadableType("application/pdf")).toBe(true);
    expect(isUploadableType("text/plain")).toBe(false);
    expect(isUploadableType("")).toBe(false);
  });
});

describe("uploadableDrag", () => {
  it("is true when any file item is an image or PDF", () => {
    expect(uploadableDrag([{ kind: "file", type: "image/png" }])).toBe(true);
    expect(uploadableDrag([{ kind: "file", type: "text/plain" },
                           { kind: "file", type: "application/pdf" }])).toBe(true);
  });
  it("is false for non-uploadable files and non-file items", () => {
    expect(uploadableDrag([{ kind: "file", type: "text/plain" }])).toBe(false);
    expect(uploadableDrag([{ kind: "string", type: "image/png" }])).toBe(false);
  });
  it("is true for a file whose type the browser withholds (empty)", () => {
    expect(uploadableDrag([{ kind: "file", type: "" }])).toBe(true);
  });
  it("is false when every file has a known unsuitable type", () => {
    expect(uploadableDrag([{ kind: "file", type: "text/plain" },
                           { kind: "file", type: "application/zip" }])).toBe(false);
  });
  it("is true when the browser lists no items at all (type unknown)", () => {
    expect(uploadableDrag([])).toBe(true);
  });
});

describe("partitionUploadable", () => {
  it("splits a drop by file.type, keeping order", () => {
    const a = file("a.png", "image/png");
    const b = file("b.txt", "text/plain");
    const c = file("c.pdf", "application/pdf");
    expect(partitionUploadable([a, b, c])).toEqual({ accepted: [a, c], rejected: [b] });
  });
});

describe("planFileDropBlocks", () => {
  const P = canonicalTitleOf("P");
  const tree = () => [
    block("tuid-a", "A", { order_idx: orderIdxOf(0) }),
    block("tuid-b", "B", { order_idx: orderIdxOf(1), children: [
      block("tuid-b1", "B1", { order_idx: orderIdxOf(0) })] }),
  ];
  const uids = [uidOf("tuid-n1"), uidOf("tuid-n2")];

  it("creates one block per text at consecutive slots under the target", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: null, order_idx: orderIdxOf(1), page_title: P },
      ["![x](/1)", "![y](/2)"], uids);
    expect(plan.fellBack).toBe(false);
    expect(plan.result.focus).toBeNull();
    expect(plan.result.ops).toEqual([
      { op: "create", uid: "tuid-n1", page_title: P, parent_uid: null,
        order_idx: 1, text: "![x](/1)" },
      { op: "create", uid: "tuid-n2", page_title: P, parent_uid: null,
        order_idx: 2, text: "![y](/2)" }]);
    expect(plan.result.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-n1", "tuid-n2", "tuid-b"]);
  });

  it("targets a nested parent", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: uidOf("tuid-b"), order_idx: orderIdxOf(1), page_title: P },
      ["t"], [uidOf("tuid-n1")]);
    expect(plan.fellBack).toBe(false);
    expect(plan.result.blocks[1].children.map((n) => n.uid)).toEqual(["tuid-b1", "tuid-n1"]);
  });

  it("falls back to the end of the page when the parent has vanished", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: uidOf("tuid-gone"), order_idx: orderIdxOf(0), page_title: P },
      ["t1", "t2"], uids);
    expect(plan.fellBack).toBe(true);
    expect(plan.result.blocks.map((n) => n.uid)).toEqual(["tuid-a", "tuid-b", "tuid-n1", "tuid-n2"]);
    expect(plan.result.ops.map((o) => "order_idx" in o && o.order_idx))
      .toEqual([2, 3]);
  });

  it("creates nothing for no texts", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: null, order_idx: orderIdxOf(0), page_title: P }, [], []);
    expect(plan.result.ops).toEqual([]);
  });

  it("first uid is exposed for scrolling", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: null, order_idx: orderIdxOf(0), page_title: P }, ["t"], [uidOf("tuid-n1")]);
    expect(plan.firstUid satisfies BlockUid | null).toBe("tuid-n1");
  });
});

describe("planUploadBlocks", () => {
  const P = canonicalTitleOf("P");
  const tree = (aText = "A") => [
    block("tuid-a", aText, { order_idx: orderIdxOf(0) }),
    block("tuid-b", "B", { order_idx: orderIdxOf(1), children: [
      block("tuid-b1", "B1", { order_idx: orderIdxOf(0) })] }),
    block("tuid-c", "C", { order_idx: orderIdxOf(2) }),
  ];
  const texts = ["![x](/a)", "![y](/b)"];
  const uids = [uidOf("tuid-n1"), uidOf("tuid-n2")];
  const plan = (blocks: ReturnType<typeof tree>, target: string,
                focused: string | null = null) =>
    planUploadBlocks(blocks, P, uidOf(target), texts, uids,
      focused === null ? null : uidOf(focused));
  const rootTexts = (p: ReturnType<typeof plan>) => p.result.blocks.map((n) => n.text);

  it("adds every upload as a sibling after a block with text", () => {
    const p = plan(tree(), "tuid-a");
    expect(rootTexts(p)).toEqual(["A", "![x](/a)", "![y](/b)", "B", "C"]);
    expect(p.result.ops.map((o) => o.op)).toEqual(["create", "create"]);
    expect(p.result.ops.every((o) => o.op === "create" && o.parent_uid === null))
      .toBe(true);
    expect(p.result.focus).toBeNull();
    expect(p.fellBack).toBe(false);
    expect(p.firstUid).toBe("tuid-n1");
  });

  it("places siblings after the block's whole subtree", () => {
    const p = plan(tree(), "tuid-b");
    expect(rootTexts(p)).toEqual(["A", "B", "![x](/a)", "![y](/b)", "C"]);
    expect(p.result.blocks[1].children.map((n) => n.text)).toEqual(["B1"]);
  });

  it("keeps a nested block's siblings at its depth", () => {
    const p = plan(tree(), "tuid-b1");
    expect(p.result.blocks[1].children.map((n) => n.text))
      .toEqual(["B1", "![x](/a)", "![y](/b)"]);
    expect(p.result.ops.every((o) => o.op === "create" && o.parent_uid === "tuid-b"))
      .toBe(true);
  });

  it("fills an empty block with the first upload", () => {
    const p = plan(tree(""), "tuid-a");
    expect(p.result.ops[0]).toEqual(
      { op: "update_text", uid: "tuid-a", text: "![x](/a)" });
    expect(p.result.ops).toHaveLength(2);
    expect(p.result.ops[1]).toMatchObject({ op: "create", uid: "tuid-n2" });
    expect(rootTexts(p)).toEqual(["![x](/a)", "![y](/b)", "B", "C"]);
    expect(p.firstUid).toBe("tuid-a");
  });

  it("treats a whitespace-only block as empty", () => {
    const p = plan(tree("  "), "tuid-a");
    expect(p.result.ops[0]).toEqual(
      { op: "update_text", uid: "tuid-a", text: "![x](/a)" });
    expect(p.result.ops).toHaveLength(2);
  });

  it("keeps the caret in a filled block that still owns focus", () => {
    expect(plan(tree(""), "tuid-a", "tuid-a").result.focus)
      .toEqual({ uid: "tuid-a", cursor: "![x](/a)".length });
    expect(plan(tree(""), "tuid-a", null).result.focus).toBeNull();
    expect(plan(tree("A"), "tuid-a", "tuid-a").result.focus).toBeNull();
  });

  it("a single upload into a block with text becomes a new sibling", () => {
    const p = planUploadBlocks(tree(), P, uidOf("tuid-a"), ["t"], [uids[0]], null);
    expect(p.result.ops).toHaveLength(1);
    expect(p.result.ops[0].op).toBe("create");
    expect(rootTexts(p)).toEqual(["A", "t", "B", "C"]);
  });

  it("falls back to the end of the page when the block is gone", () => {
    const p = plan(tree(), "tuid-gone");
    expect(p.fellBack).toBe(true);
    expect(p.result.ops.every((o) => o.op === "create" && o.parent_uid === null))
      .toBe(true);
    expect(p.result.blocks.map((n) => n.uid))
      .toEqual(["tuid-a", "tuid-b", "tuid-c", "tuid-n1", "tuid-n2"]);
    expect(p.firstUid).toBe("tuid-n1");
  });
});

describe("fileDropNotice", () => {
  it("is null when nothing went wrong", () => {
    expect(fileDropNotice([], [])).toBeNull();
  });
  it("words failures like /upload does", () => {
    expect(fileDropNotice(["a.png: boom"], [])).toBe("Upload failed — a.png: boom");
    expect(fileDropNotice(["a.png: x", "b.png: y"], []))
      .toBe("2 uploads failed — a.png: x; b.png: y");
  });
  it("names the files that were not uploadable", () => {
    expect(fileDropNotice([], ["n.txt", "z.zip"]))
      .toContain("n.txt, z.zip");
  });
  it("reports both together", () => {
    const text = fileDropNotice(["a.png: x"], ["n.txt"])!;
    expect(text).toContain("Upload failed — a.png: x");
    expect(text).toContain("n.txt");
  });
});
