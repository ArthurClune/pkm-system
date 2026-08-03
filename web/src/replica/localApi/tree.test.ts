// @vitest-environment node
import { afterEach, describe, expect, test } from "vitest";
import { openTestDb, type TestDb } from "../testDb";
import { fetchAncestors } from "./tree";

let t: TestDb;

afterEach(() => {
  t?.close();
});

function insertPage(pageId: number, title: string) {
  t.db.exec("INSERT INTO pages(id, title) VALUES (?, ?)", [pageId, title]);
}

function seedLinearChain(prefix: string, ancestors: number): string {
  insertPage(1, `${prefix} page`);
  let parentUid: string | null = null;
  for (let i = 0; i <= ancestors; i += 1) {
    const uid = `${prefix}-${i}`;
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)",
      [uid, 1, parentUid, i, `${prefix} text ${i}`, null, 0, 0, 0],
    );
    parentUid = uid;
  }
  return `${prefix}-${ancestors}`;
}

function seedFiveNodeCycle(prefix: string): string {
  insertPage(1, `${prefix} page`);
  const uids = Array.from({ length: 5 }, (_, i) => `${prefix}-${i}`);
  for (let i = 0; i < uids.length; i += 1) {
    t.db.exec(
      "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text,"
      + " heading, collapsed, created_at, updated_at)"
      + " VALUES (?,?,?,?,?,?,?,?,?)",
      [uids[i], 1, null, i, `${prefix} text ${i}`, null, 0, 0, 0],
    );
  }
  for (let i = 0; i < uids.length; i += 1) {
    t.db.exec(
      "UPDATE blocks SET parent_uid = ? WHERE uid = ?",
      [uids[(i + 1) % uids.length], uids[i]],
    );
  }
  return uids[0];
}

describe("fetchAncestors", () => {
  test.each([100, 101, 102, 150])(
    "returns %i ancestors root-first without truncation",
    async (ancestors) => {
      t = await openTestDb();
      const startUid = seedLinearChain(`chain-${ancestors}`, ancestors);
      expect(fetchAncestors(t.db, [startUid])).toEqual(new Map([
        [startUid, Array.from({ length: ancestors }, (_, i) =>
          `chain-${ancestors} text ${i}`)],
      ]));
    },
  );

  test("returns a five-node cycle as four unique ancestors, excluding the start uid", async () => {
    t = await openTestDb();
    const startUid = seedFiveNodeCycle("cycle");
    const result = fetchAncestors(t.db, [startUid]);
    expect(result.size).toBe(1);
    expect(result.get(startUid)).toEqual([
      "cycle text 4",
      "cycle text 3",
      "cycle text 2",
      "cycle text 1",
    ]);
  });
});
