import { expect, test } from "vitest";
import type { BatchId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { memReplica } from "./memReplica";
import { uidOf, batchIdOf, pendingRowIdOf } from "../test-helpers";

const op = (tag: string): BlockOp =>
  ({ op: "delete", uid: uidOf(`tuid-${tag}`) });
// Every test here picks an arbitrary batch-id string, same shape as the
// production mint; this mints the brand once rather than at every call.
const bid = (s: string): BatchId => batchIdOf(s);

test("deleteBatch leaves the queue intact when the id is missing", async () => {
  const replica = memReplica();
  await replica.enqueue([op("first")], bid("batch-1"));
  await replica.enqueue([op("second")], bid("batch-2"));

  await expect(replica.deleteBatch(pendingRowIdOf(999), bid("batch-1"))).resolves.toEqual({ pending: 2 });
  expect(replica.rows).toEqual([
    { id: 1, batch_id: "batch-1", ops: [op("first")], poisoned: false },
    { id: 2, batch_id: "batch-2", ops: [op("second")], poisoned: false },
  ]);
});

test("deleteBatch leaves the queue intact when the batch id differs", async () => {
  const replica = memReplica();
  await replica.enqueue([op("first")], bid("batch-1"));

  await expect(replica.deleteBatch(pendingRowIdOf(1), bid("batch-other"))).resolves.toEqual({ pending: 1 });
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
