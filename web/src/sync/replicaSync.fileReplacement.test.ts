// @vitest-environment node
// A poison repair driven by the real replicaSync, through the real Replica
// facade and RPC port, into the real worker handlers, over a damaged replica
// file whose replacement fails once. The damaged database is really closed
// when its file is discarded, so the queue survives only if it was made
// durable somewhere else first.
import { expect, test } from "vitest";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { Snapshot } from "../replica/apply";
import { createCarryStore } from "../replica/carryStore";
import { createReplica, type PendingRowId } from "../replica/client";
import type { ReplicaDb } from "../replica/db";
import { serveRpc, toPortLike } from "../replica/rpc";
import { failingOnce, fakeCarryFiles, openRawTestDb, withDamagedFreelist }
  from "../replica/testDb";
import { buildHandlers, type WorkerDeps } from "../replica/workerHandlers";
import { createReplicaSync } from "./replicaSync";
import { uid } from "../test-helpers";

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: (5 as SyncSeq),
  pages: [{ id: 1, title: "AI", created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uid("uid_b1"), page_id: 1, parent_uid: null, order_idx: 0,
    text: "hello", heading: null, view_type: null, collapsed: 0,
    created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
};
const SQLITE_FULL = "SQLITE_FULL: sqlite3 result code 13: database or disk is full";

test("a poison repair whose file replacement fails keeps every queued row for its Retry", async () => {
  const damaged = await openRawTestDb();
  const fresh = await openRawTestDb();
  const carryDb = await openRawTestDb();
  let isDamaged = false;
  let current: ReplicaDb = withDamagedFreelist(damaged.db, /^DELETE /i, () => isDamaged);
  const carry = createCarryStore(fakeCarryFiles(carryDb));
  // What the carry held at each unlink of the replica file: the rows must
  // already be durable there when the old file goes.
  const carriedAtDiscard: string[][] = [];
  const deps: WorkerDeps = {
    openDb: async () => current,
    discardDbFile: () => {
      carriedAtDiscard.push(carry.read().map((row) => row.batch_id));
      damaged.close();
      // The new file takes its schema, then fails the first write of the
      // queue's rows into it: after that the Retry has a working file and
      // nothing tells it rows are missing.
      current = failingOnce(
        fresh.db, /^INSERT (OR IGNORE )?INTO pending_ops\(id,/, SQLITE_FULL);
    },
    carry,
    nowMs: () => 10,
  };
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers(deps));
  const replica = createReplica(toPortLike(ch.port1));
  const sync = createReplicaSync({
    replica,
    fetchJson: async (path) => {
      if (path === "/api/sync/snapshot") return SNAP;
      throw new Error(`unexpected fetch ${path}`);
    },
    clientId: "c1" as ClientId,
    onState: () => {},
  });

  await replica.init();
  await replica.applySnapshot(SNAP);
  await replica.enqueue(
    [{ op: "move", uid: uid("uid_gone"), parent_uid: uid("uid_b1"), order_idx: 1 }],
    "rejected" as BatchId);
  await replica.enqueue([{ op: "update_text", uid: uid("uid_b1"), text: "edited" }],
                        "valid" as BatchId);
  await replica.markPoisoned((1 as PendingRowId), "HTTP 400", "rejected" as BatchId);
  isDamaged = true;

  await expect(sync.rebaseAuthoritative("poison")).rejects.toThrow(/SQLITE_FULL/);
  expect(carriedAtDiscard).toEqual([["rejected", "valid"]]);
  // the repair banner's Retry
  await sync.rebaseAuthoritative("poison");
  expect(carry.exists()).toBe(false);

  expect((await replica.pendingBatches())
    .map(({ id, batch_id, poisoned }) => ({ id, batch_id, poisoned })))
    .toEqual([
      { id: 1, batch_id: "rejected", poisoned: true },
      { id: 2, batch_id: "valid", poisoned: false },
    ]);
  expect(fresh.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
    .toEqual([{ text: "edited" }]);
});
