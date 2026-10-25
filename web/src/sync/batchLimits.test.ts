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
