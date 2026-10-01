import { expect, test } from "vitest";
import type { BatchId, SyncSeq } from "../api/brands";
import { splitAckedRows } from "./ackedRows";
import type { AckedBatch, PendingRowId } from "./client";
import type { DurablePendingRow } from "./queue";

// Every test here picks an arbitrary batch-id string, same shape as the
// production mint; this mints the brand once rather than at every call.
const bid = (s: string): BatchId => s as BatchId;

const r1: DurablePendingRow = {
  id: (1 as PendingRowId), batch_id: bid("a"), ops_json: "[]", poisoned: 0, error: null };
const r2: DurablePendingRow = {
  id: (2 as PendingRowId), batch_id: bid("b"), ops_json: "[]", poisoned: 0, error: null };

test("an ack matching a row by id and batch id settles it and the rest remain", () => {
  const ack: AckedBatch = { id: 1 as PendingRowId, batch_id: bid("a"), seq: 7 as SyncSeq };
  expect(splitAckedRows([r1, r2], [ack]))
    .toEqual({ settled: [ack], remaining: [r2] });
});

test("an ack whose batch id differs from its row's settles nothing", () => {
  expect(splitAckedRows([r1, r2], [{ id: (1 as PendingRowId), batch_id: bid("other"), seq: (7 as SyncSeq) }]))
    .toEqual({ settled: [], remaining: [r1, r2] });
});

test("an ack for an id no row holds is dropped", () => {
  expect(splitAckedRows([r1, r2], [{ id: (9 as PendingRowId), batch_id: bid("a"), seq: (7 as SyncSeq) }]).settled)
    .toEqual([]);
});

test("two acks for one row settle it once", () => {
  expect(splitAckedRows([r1, r2], [
    { id: (2 as PendingRowId), batch_id: bid("b"), seq: (8 as SyncSeq) }, { id: (2 as PendingRowId), batch_id: bid("b"), seq: null },
  ])).toEqual({ settled: [{ id: 2, batch_id: "b", seq: 8 }], remaining: [r1] });
});
