import { describe, expect, it } from "vitest";
import { block, orderIdxOf, canonicalTitleOf, uidOf } from "../test-helpers";
import type { BlockUid } from "../api/brands";
import { fileDropNotice, isUploadableType, partitionUploadable, planFileDropBlocks,
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
