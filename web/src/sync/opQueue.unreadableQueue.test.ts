// @vitest-environment node
// The real op queue over the real worker handlers, through the RPC port, on
// a replica file whose pending_ops turns unreadable with a lane entry
// waiting: the lane is ordered by the drain's nextBatch read, so it delivers
// only once that read can succeed again.
import { afterEach, expect, test, vi } from "vitest";
import type { BatchId } from "../api/brands";
import type { OpBatch } from "../api/payloads";
import { createCarryStore } from "../replica/carryStore";
import { createReplica } from "../replica/client";
import type { ReplicaDb } from "../replica/db";
import { serveRpc, toPortLike } from "../replica/rpc";
import { fakeCarryFiles, openRawTestDb, withUnreadableQueue } from "../replica/testDb";
import { buildHandlers } from "../replica/workerHandlers";
import { batchIdOf, seqOf, uidOf } from "../test-helpers";
import { createOpQueue } from "./opQueue";

afterEach(() => { vi.restoreAllMocks(); });

test("a lane entry behind an unreadable durable queue still delivers, after the readable rows",
async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const old = await openRawTestDb();
  const fresh = await openRawTestDb();
  let damaged = false;
  let failWrite = false;
  let discarded = false;
  const writes: ReplicaDb = {
    ...old.db,
    exec(sql, params) {
      if (failWrite && /^\s*INSERT INTO pending_ops/i.test(sql)) {
        failWrite = false;
        throw new Error("disk I/O error");
      }
      old.db.exec(sql, params);
    },
    transaction: (fn) => old.db.transaction(fn),
  };
  const oldFile = withUnreadableQueue(writes, {
    isDamaged: () => damaged, readableBelow: Number.MAX_SAFE_INTEGER,
  });
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => discarded ? fresh.db : oldFile,
    discardDbFile: () => { discarded = true; },
    carry: createCarryStore(fakeCarryFiles(await openRawTestDb())),
    nowMs: () => 10,
  }));
  const replica = createReplica(toPortLike(ch.port1), () => {
    ch.port1.close();
    ch.port2.close();
  });
  const posted: BatchId[] = [];
  let minted = 0;
  let unsent = 0;
  const queue = createOpQueue(replica, {
    post: async (body: OpBatch) => {
      posted.push(body.batch_id);
      return { ok: true, ts: 0, applied: body.ops.length, seq: seqOf(posted.length), skipped: [] };
    },
    poisonStore: { read: () => [], write: () => undefined },
    newBatchId: () => batchIdOf(`b${minted += 1}`),
  });
  queue.onUnsentInMemory((n) => { unsent = n; });
  await replica.init();
  const op = { op: "update_text" as const, uid: uidOf("uid_b1"), text: "x" };

  // offline: a durable row, then a write that fails into the lane
  const durable = queue.enqueue([op]);
  await durable.settled;
  failWrite = true;
  const lane = queue.enqueue([op]);
  await lane.settled;
  expect(unsent).toBe(1);
  damaged = true;

  queue.setOnline(true);
  await expect(queue.drain()).resolves.toEqual({ status: "drained" });
  expect(posted).toEqual([batchIdOf("b1"), batchIdOf("b2")]);
  await replica.dispose();
});
