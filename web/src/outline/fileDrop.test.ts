import { describe, expect, it } from "vitest";
import { block, ord, title, uid } from "../test-helpers";
import type { BlockUid } from "../api/brands";
import { isUploadableType, partitionUploadable, planFileDropBlocks,
         uploadableDrag } from "./fileDrop";

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
  const P = title("P");
  const tree = () => [
    block("a", "A", { order_idx: ord(0) }),
    block("b", "B", { order_idx: ord(1), children: [
      block("b1", "B1", { order_idx: ord(0) })] }),
  ];
  const uids = [uid("n1"), uid("n2")];

  it("creates one block per text at consecutive slots under the target", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: null, order_idx: ord(1), page_title: P },
      ["![x](/1)", "![y](/2)"], uids);
    expect(plan.fellBack).toBe(false);
    expect(plan.result.focus).toBeNull();
    expect(plan.result.ops).toEqual([
      { op: "create", uid: "n1", page_title: P, parent_uid: null,
        order_idx: 1, text: "![x](/1)" },
      { op: "create", uid: "n2", page_title: P, parent_uid: null,
        order_idx: 2, text: "![y](/2)" }]);
    expect(plan.result.blocks.map((n) => n.uid)).toEqual(["a", "n1", "n2", "b"]);
  });

  it("targets a nested parent", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: uid("b"), order_idx: ord(1), page_title: P },
      ["t"], [uid("n1")]);
    expect(plan.fellBack).toBe(false);
    expect(plan.result.blocks[1].children.map((n) => n.uid)).toEqual(["b1", "n1"]);
  });

  it("falls back to the end of the page when the parent has vanished", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: uid("gone"), order_idx: ord(0), page_title: P },
      ["t1", "t2"], uids);
    expect(plan.fellBack).toBe(true);
    expect(plan.result.blocks.map((n) => n.uid)).toEqual(["a", "b", "n1", "n2"]);
    expect(plan.result.ops.map((o) => "order_idx" in o && o.order_idx))
      .toEqual([2, 3]);
  });

  it("creates nothing for no texts", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: null, order_idx: ord(0), page_title: P }, [], []);
    expect(plan.result.ops).toEqual([]);
  });

  it("first uid is exposed for scrolling", () => {
    const plan = planFileDropBlocks(tree(), P,
      { parent_uid: null, order_idx: ord(0), page_title: P }, ["t"], [uid("n1")]);
    expect(plan.firstUid satisfies BlockUid | null).toBe("n1");
  });
});
