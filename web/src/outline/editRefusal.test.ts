import { expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import { BATCH_TOO_LARGE_NOTICE,
         MAX_OPS_PER_BATCH } from "../sync/batchLimits";
import { block, canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { DEPTH_NOTICE, MAX_OUTLINE_DEPTH } from "./depthCap";
import { editRefusal } from "./editRefusal";

type CreateOp = Extract<BlockOp, { op: "create" }>;
const title = canonicalTitleOf("Page");

function creates(n: number, prefix = "tuid-c"): CreateOp[] {
  return Array.from({ length: n }, (_, i) => ({
    op: "create" as const, uid: uidOf(`${prefix}-${i}`), page_title: title,
    parent_uid: null, order_idx: orderIdxOf(i), text: "x",
  }));
}

function chain(depth: number) {
  let node = block("tuid-leaf", "x");
  for (let i = 1; i < depth; i++) node = block(`tuid-n${i}`, "x", { children: [node] });
  return [node];
}

it("returns BATCH_TOO_LARGE_NOTICE for 501 creates", () => {
  expect(editRefusal(null, creates(MAX_OPS_PER_BATCH + 1), []))
    .toBe(BATCH_TOO_LARGE_NOTICE);
});

it("returns null for 500 creates", () => {
  expect(editRefusal(null, creates(MAX_OPS_PER_BATCH), [])).toBeNull();
});

it("counts alsoShipping toward the size", () => {
  expect(editRefusal(null, creates(MAX_OPS_PER_BATCH),
                     creates(1, "tuid-d"))).toBe(BATCH_TOO_LARGE_NOTICE);
});

it("judges depth only when a tree is given", () => {
  const ops = creates(1);
  const deep = chain(MAX_OUTLINE_DEPTH + 1);
  expect(editRefusal(null, [{ ...ops[0]!, uid: uidOf("tuid-leaf") }], []))
    .toBeNull();
  expect(editRefusal(deep, [{ ...ops[0]!, uid: uidOf("tuid-leaf") }], []))
    .toBe(DEPTH_NOTICE);
});

it("returns the depth notice before the size notice", () => {
  const deep = chain(MAX_OUTLINE_DEPTH + 1);
  const ops = [...creates(MAX_OPS_PER_BATCH), {
    ...creates(1, "tuid-z")[0]!, uid: uidOf("tuid-leaf"),
  }];
  expect(editRefusal(deep, ops, [])).toBe(DEPTH_NOTICE);
});
