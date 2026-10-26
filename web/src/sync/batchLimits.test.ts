import { expect, it } from "vitest";
import type { BlockOp } from "../api/ops";
import { canonicalTitleOf, orderIdxOf, uidOf } from "../test-helpers";
import { BATCH_TOO_LARGE_NOTICE, MAX_OPS_PER_BATCH, PRIVATE_BODY_MAX_BYTES,
         findBatchSizeViolation } from "./batchLimits";

import fixture from "../../../shared/fixtures/batch_limits.json";

const PAGE = canonicalTitleOf("Big");

const createOp = (n: number, text: string): BlockOp => ({
  op: "create", uid: uidOf(`tuid-b${n}`), page_title: PAGE,
  parent_uid: null, order_idx: orderIdxOf(n), text,
});

it("the constants equal the shared fixture", () => {
  expect(MAX_OPS_PER_BATCH).toBe(fixture.max_ops_per_batch);
  expect(PRIVATE_BODY_MAX_BYTES).toBe(fixture.private_body_max_bytes);
  expect(BATCH_TOO_LARGE_NOTICE).toBe(
    "This change is too large to save in one step.");
});

it("500 small ops are within the limits and 501 are over the op count", () => {
  const ops = (n: number) =>
    Array.from({ length: n }, (_, i) => createOp(i, "x"));
  expect(findBatchSizeViolation(ops(500))).toBeNull();
  expect(findBatchSizeViolation(ops(501))).toBe("ops");
});

it("a batch whose JSON passes the byte cap is over by bytes", () => {
  const text = "\u0001".repeat(1_000_000); // six bytes each once escaped
  const ops = Array.from({ length: 12 }, (_, i) => createOp(i, text));
  expect(findBatchSizeViolation(ops)).toBe("bytes");
});

it("a large batch of plain text under the cap is not refused", () => {
  const text = "a".repeat(1_000_000);
  const ops = Array.from({ length: 12 }, (_, i) => createOp(i, text));
  expect(findBatchSizeViolation(ops)).toBeNull();
});

// A page title is at most 1,000 code points, which JSON can escape to six
// bytes each: more than the old per-op allowance of 1,024 bytes.
const ESCAPED_TITLE = "\u0001".repeat(1_000);
const textBytesJustUnder = (ops: number): number =>
  Math.floor((PRIVATE_BODY_MAX_BYTES - ops * 1_024 - 4_096 - 6) / 6);

it("a batch whose titles escape past the old allowance is not under-counted",
   () => {
  const each = Math.floor(textBytesJustUnder(500) / 500);
  const ops: BlockOp[] = Array.from({ length: 500 }, (_, i) => ({
    op: "create", uid: uidOf(`tuid-b${i}`),
    page_title: canonicalTitleOf(ESCAPED_TITLE), parent_uid: null,
    order_idx: orderIdxOf(i), text: "\u0001".repeat(each),
  }));
  expect(findBatchSizeViolation(ops)).toBe("bytes");
});

it("the allowance covers a title the queue stamps at the cap", () => {
  // No title in the ops: the queue stamps update_text's page_title later.
  const each = Math.floor(textBytesJustUnder(500) / 500);
  const ops: BlockOp[] = Array.from({ length: 500 }, (_, i) => ({
    op: "update_text", uid: uidOf(`tuid-b${i}`),
    text: "\u0001".repeat(each),
  }));
  expect(findBatchSizeViolation(ops)).toBe("bytes");
});
