// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import { batchIdOf } from "../test-helpers";
import { parsePendingOps } from "./pendingOps";
import { enqueueBatch } from "./queue";
import { openTestDb, type TestDb } from "./testDb";

// The server's replay hash leaves out these fields per op kind; the server
// test reads the same list. Hand-edited.
import fixture from "../../../shared/fixtures/op_hashes.json";

let t: TestDb;
beforeEach(async () => {
  t = await openTestDb();
  t.db.exec("INSERT INTO pages(id, title) VALUES (1, 'AI')");
  t.db.exec(
    "INSERT INTO blocks(uid, page_id, parent_uid, order_idx, text)" +
    " VALUES ('uid_q1', 1, NULL, 0, 'original text')");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => { t.close(); vi.restoreAllMocks(); });

/** The op as stored, minus the keys it was sent with: what the worker
 * filled in. */
function filledKeys(sent: BlockOp): string[] {
  const row = t.db.select("SELECT ops_json FROM pending_ops", ["ops_json"]);
  const stored = JSON.parse(row[0].ops_json) as Record<string, unknown>[];
  return Object.keys(stored[0]).filter((key) => !(key in sent)).sort();
}

test("the worker fills exactly the fields the replay hash leaves out", () => {
  const filled: Record<string, string[]> = {};
  for (const [index, c] of fixture.cases.entries()) {
    if (!c.name.endsWith("-minimal")) continue;
    // the fixture's uids are placeholders; the block the op targets must
    // exist in the replica for the worker to fill anything
    const [op] = parsePendingOps(JSON.stringify([
      "uid" in c.op && c.op.op !== "create"
        ? { ...c.op, uid: "uid_q1" } : c.op]));
    t.db.exec("DELETE FROM pending_ops");
    enqueueBatch(t.db, [op], 99, batchIdOf(`parity-${index}`));
    const keys = filledKeys(op);
    if (keys.length > 0) filled[op.op] = keys;
  }
  const expected = Object.fromEntries(
    Object.entries(fixture.replay_excluded)
      .map(([kind, fields]) => [kind, [...fields].sort()]));
  expect(filled).toEqual(expected);
});
