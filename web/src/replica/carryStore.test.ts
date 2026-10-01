// @vitest-environment node
import { expect, test } from "vitest";
import { createCarryStore } from "./carryStore";
import type { PendingRowId } from "./client";
import type { DurablePendingRow } from "./queue";
import { failingOnce, fakeCarryFiles, openRawTestDb } from "./testDb";

const row1: DurablePendingRow = {
  id: (1 as PendingRowId), batch_id: "rejected",
  ops_json: JSON.stringify([{ op: "delete", uid: "uid_a" }]),
  poisoned: 1, error: "HTTP 400",
};
const row2: DurablePendingRow = {
  id: (2 as PendingRowId), batch_id: "valid",
  ops_json: JSON.stringify([{ op: "delete", uid: "uid_b" }]),
  poisoned: 0, error: null,
};
const row3: DurablePendingRow = {
  id: (5 as PendingRowId), batch_id: "later", ops_json: "[]", poisoned: 0, error: null,
};
const SQLITE_FULL = "SQLITE_FULL: sqlite3 result code 13: database or disk is full";

test("a written carry reads back verbatim, ids, poison and error included", async () => {
  const store = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  expect(store.exists()).toBe(false);
  store.write([row1, row2]);
  expect(store.exists()).toBe(true);
  expect(store.read()).toEqual([row1, row2]);
});

test("a second write replaces the first", async () => {
  const store = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  store.write([row1, row2]);
  store.write([row3]);
  expect(store.read()).toEqual([row3]);
});

test("a carry whose table never committed reads as empty", async () => {
  const files = fakeCarryFiles(await openRawTestDb());
  files.open();
  expect(createCarryStore(files).read()).toEqual([]);
});

test("discard removes the carry", async () => {
  const store = createCarryStore(fakeCarryFiles(await openRawTestDb()));
  store.write([row1]);
  store.discard();
  expect(store.exists()).toBe(false);
  expect(store.read()).toEqual([]);
});

test("write closes the carry even when the insert fails", async () => {
  const inner = fakeCarryFiles(await openRawTestDb());
  const store = createCarryStore({
    exists: () => inner.exists(),
    unlink: () => { inner.unlink(); },
    open: () => {
      const handle = inner.open();
      return {
        db: failingOnce(handle.db, /^INSERT OR IGNORE INTO pending_ops/, SQLITE_FULL),
        close: handle.close,
      };
    },
  });
  expect(() => { store.write([row1]); }).toThrow(/SQLITE_FULL/);
  expect(inner.closes).toBe(1);
  expect(store.read()).toEqual([]);
});
