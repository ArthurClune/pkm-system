// @vitest-environment node
// The first snapshot of an empty replica, through the real replicaSync, the
// real Replica facade and RPC port, and the real worker handlers. A batch
// queued before the snapshot is fetched can be acknowledged while the fetch is
// out: the server answered before that commit, so the snapshot lacks the
// batch's edit, and the ack has already deleted the pending row that would
// replay it. The worker must refuse such a snapshot and bootstrap must refetch.
import { expect, test } from "vitest";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { Snapshot } from "../replica/apply";
import { createReplica, type PendingRowId, type Replica } from "../replica/client";
import { serveRpc, toPortLike } from "../replica/rpc";
import { openRawTestDb } from "../replica/testDb";
import { buildHandlers } from "../replica/workerHandlers";
import { createReplicaSync, PENDING_CHANGED_CAP } from "./replicaSync";
import { PullStarvedError } from "./syncFailures";
import { orderIdxOf, pageIdOf, canonicalTitleOf, uidOf } from "../test-helpers";

const snapshotAt = (seq: number, text: string): Snapshot => ({
  generation: "gen-1", plain_space_title_canonicalization: false,
  seq: (seq as SyncSeq),
  pages: [{ id: pageIdOf(1), title: canonicalTitleOf("AI"), created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uidOf("uid_b1"), page_id: pageIdOf(1), parent_uid: null, order_idx: orderIdxOf(0),
    text, heading: null, view_type: null, collapsed: 0,
    created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
});
const EMPTY_FEED = {
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 7, latest_seq: 7, pages: [], blocks: [], sidebar: [], tombstones: [],
};

async function setup(
  answer: (n: number, replica: Replica, pendingId: PendingRowId,
           db: Awaited<ReturnType<typeof openRawTestDb>>["db"]) => Promise<Snapshot>,
) {
  const t = await openRawTestDb();
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => t.db, nowMs: () => 10,
  }));
  const replica = createReplica(toPortLike(ch.port1));
  const snapshotPaths: string[] = [];
  let pendingId = 0 as PendingRowId;
  const sync = createReplicaSync({
    replica,
    fetchJson: async (path) => {
      if (path.startsWith("/api/sync/snapshot")) {
        snapshotPaths.push(path);
        return answer(snapshotPaths.length, replica, pendingId, t.db);
      }
      if (path.startsWith("/api/sync/changes")) return EMPTY_FEED;
      throw new Error(`unexpected fetch ${path}`);
    },
    clientId: "c1" as ClientId,
    onState: () => {},
  });
  await replica.init();
  await replica.enqueue(
    [{ op: "update_text", uid: uidOf("uid_b1"), text: "edited" }], "b-edit" as BatchId);
  pendingId = (await replica.pendingBatches())[0].id;
  return { t, replica, sync, snapshotPaths };
}

const textOf = (t: { db: { select: (sql: string) => unknown[] } }): unknown =>
  t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'");

test("a snapshot answered before a batch acked during its fetch is refetched", async () => {
  const textsSeenAtFetch: unknown[] = [];
  const ctx = await setup(async (n, replica, id, db) => {
    textsSeenAtFetch.push(db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"));
    if (n === 1) {
      await replica.deleteBatch(id, "b-edit" as BatchId, 7 as SyncSeq);
      return snapshotAt(5, "hello");
    }
    return snapshotAt(7, "edited");
  });
  await ctx.sync.start();
  expect(ctx.snapshotPaths).toHaveLength(2);
  // the stale snapshot was refused untouched: nothing was ever visible
  expect(textsSeenAtFetch).toEqual([[], []]);
  expect(textOf(ctx.t)).toEqual([{ text: "edited" }]);
});

test("a snapshot already at the acked seq applies on the first fetch", async () => {
  const ctx = await setup(async (_n, replica, id) => {
    await replica.deleteBatch(id, "b-edit" as BatchId, 7 as SyncSeq);
    return snapshotAt(7, "edited");
  });
  await ctx.sync.start();
  expect(ctx.snapshotPaths).toHaveLength(1);
  expect(textOf(ctx.t)).toEqual([{ text: "edited" }]);
});

test("a snapshot that never covers the acks ends in PullStarvedError at the cap", async () => {
  let attempts = 0;
  const ctx = await setup(async (_n, replica) => {
    // every attempt queues one batch and sees the previous one acked beyond
    // the snapshot, so the pending set never settles
    attempts += 1;
    const [head] = await replica.pendingBatches();
    await replica.enqueue(
      [{ op: "update_text", uid: uidOf("uid_b1"), text: `e${attempts}` }],
      `b-${attempts}` as BatchId);
    await replica.deleteBatch(head.id, head.batch_id, 99 as SyncSeq);
    return snapshotAt(5, "hello");
  });
  await expect(ctx.sync.start()).rejects.toBeInstanceOf(PullStarvedError);
  expect(ctx.snapshotPaths).toHaveLength(PENDING_CHANGED_CAP);
});
