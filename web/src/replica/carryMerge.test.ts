import { expect, test } from "vitest";
import { mergeCarriedRows } from "./carryMerge";
import type { DurablePendingRow } from "./queue";
import { batchIdOf, pendingRowIdOf } from "../test-helpers";

const row = (rowId: number, batch: string, error: string | null = null):
  DurablePendingRow => ({ id: pendingRowIdOf(rowId), batch_id: batchIdOf(batch),
                          ops_json: "[]", poisoned: error ? 1 : 0, error });

test("the rows either file holds, by id, oldest first", () => {
  expect(mergeCarriedRows([row(3, "c")], [row(1, "a"), row(2, "b")]))
    .toEqual([row(1, "a"), row(2, "b"), row(3, "c")]);
});

test("an empty carry keeps every row the replica still holds", () => {
  expect(mergeCarriedRows([], [row(1, "a"), row(2, "b")]))
    .toEqual([row(1, "a"), row(2, "b")]);
});

test("on an id both files hold, the carry's row wins", () => {
  expect(mergeCarriedRows([row(1, "a", "HTTP 400")], [row(1, "a")]))
    .toEqual([row(1, "a", "HTTP 400")]);
});
