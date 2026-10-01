import { expect, test } from "vitest";
import type { BatchId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { PendingRowId } from "../replica/client";
import { memReplica } from "./memReplica";

const op = (uid: string): BlockOp => ({ op: "delete", uid });
// Every test here picks an arbitrary batch-id string, same shape as the
// production mint; this mints the brand once rather than at every call.
const bid = (s: string): BatchId => s as BatchId;

test("deleteBatch leaves the queue intact when the id is missing", async () => {
  const replica = memReplica();
  await replica.enqueue([op("first")], bid("batch-1"));
  await replica.enqueue([op("second")], bid("batch-2"));

  await expect(replica.deleteBatch((999 as PendingRowId), bid("batch-1"))).resolves.toEqual({ pending: 2 });
  expect(replica.rows).toEqual([
    { id: 1, batch_id: "batch-1", ops: [op("first")], poisoned: false },
    { id: 2, batch_id: "batch-2", ops: [op("second")], poisoned: false },
  ]);
});

test("deleteBatch leaves the queue intact when the batch id differs", async () => {
  const replica = memReplica();
  await replica.enqueue([op("first")], bid("batch-1"));

  await expect(replica.deleteBatch((1 as PendingRowId), bid("batch-other"))).resolves.toEqual({ pending: 1 });
  expect(replica.rows).toEqual([
    { id: 1, batch_id: "batch-1", ops: [op("first")], poisoned: false },
  ]);
});

test("enqueue ignores an empty ops array while returning its batch id", async () => {
  const replica = memReplica();
  await replica.enqueue([op("existing")], bid("batch-1"));

  await expect(replica.enqueue([], bid("empty-batch"))).resolves.toEqual({
    pending: 1,
    batchId: "empty-batch",
  });
  expect(replica.enqueued).toEqual(["batch-1"]);
  expect(replica.rows).toEqual([
    { id: 1, batch_id: "batch-1", ops: [op("existing")], poisoned: false },
  ]);
});
