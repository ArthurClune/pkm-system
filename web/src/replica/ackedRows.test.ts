import { expect, test } from "vitest";
import { splitAckedRows } from "./ackedRows";
import type { DurablePendingRow } from "./queue";

const r1: DurablePendingRow = {
  id: 1, batch_id: "a", ops_json: "[]", poisoned: 0, error: null };
const r2: DurablePendingRow = {
  id: 2, batch_id: "b", ops_json: "[]", poisoned: 0, error: null };

test("an ack matching a row by id and batch id settles it and the rest remain", () => {
  const ack = { id: 1, batch_id: "a", seq: 7 };
  expect(splitAckedRows([r1, r2], [ack]))
    .toEqual({ settled: [ack], remaining: [r2] });
});

test("an ack whose batch id differs from its row's settles nothing", () => {
  expect(splitAckedRows([r1, r2], [{ id: 1, batch_id: "other", seq: 7 }]))
    .toEqual({ settled: [], remaining: [r1, r2] });
});

test("an ack for an id no row holds is dropped", () => {
  expect(splitAckedRows([r1, r2], [{ id: 9, batch_id: "a", seq: 7 }]).settled)
    .toEqual([]);
});

test("two acks for one row settle it once", () => {
  expect(splitAckedRows([r1, r2], [
    { id: 2, batch_id: "b", seq: 8 }, { id: 2, batch_id: "b", seq: null },
  ])).toEqual({ settled: [{ id: 2, batch_id: "b", seq: 8 }], remaining: [r1] });
});
