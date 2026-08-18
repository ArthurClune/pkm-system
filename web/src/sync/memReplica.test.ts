import { expect, test } from "vitest";
import type { BlockOp } from "../api/ops";
import { memReplica } from "./memReplica";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

test("deleteBatch leaves the queue intact when the id is missing", async () => {
  const replica = memReplica();
  await replica.enqueue([op("first")], "batch-1");
  await replica.enqueue([op("second")], "batch-2");

  await expect(replica.deleteBatch(999)).resolves.toEqual({ pending: 2 });
  expect(replica.rows).toEqual([
    { id: 1, batch_id: "batch-1", ops: [op("first")], poisoned: false },
    { id: 2, batch_id: "batch-2", ops: [op("second")], poisoned: false },
  ]);
});

test("enqueue ignores an empty ops array while returning its batch id", async () => {
  const replica = memReplica();
  await replica.enqueue([op("existing")], "batch-1");

  await expect(replica.enqueue([], "empty-batch")).resolves.toEqual({
    pending: 1,
    batchId: "empty-batch",
  });
  expect(replica.enqueued).toEqual(["batch-1"]);
  expect(replica.rows).toEqual([
    { id: 1, batch_id: "batch-1", ops: [op("existing")], poisoned: false },
  ]);
});
