// @vitest-environment node
// A feed rebase driven by the real replicaSync, through the real Replica
// facade and RPC port, into the real worker handlers. The server's ack for
// the flushed batch stands for a rename replay: what it saved differs from
// the wire text, and the snapshot carries the saved text. Recovery must keep
// the server's result rather than replay the acknowledged batch over it.
import { expect, test } from "vitest";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { Changes, Snapshot } from "../replica/apply";
import { createReplica } from "../replica/client";
import { serveRpc, toPortLike } from "../replica/rpc";
import { openRawTestDb } from "../replica/testDb";
import { buildHandlers } from "../replica/workerHandlers";
import { createReplicaSync } from "./replicaSync";
import { pageId, title, uid } from "../test-helpers";

const BEFORE: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false, seq: (5 as SyncSeq),
  pages: [{ id: pageId(1), title: title("AI"), created_at: 1, updated_at: 1 }],
  blocks: [{ uid: uid("uid_b1"), page_id: pageId(1), parent_uid: null, order_idx: 0,
    text: "hello", heading: null, view_type: null, collapsed: 0,
    created_at: 1, updated_at: 1, refs: [] }],
  sidebar: [],
};
const AFTER: Snapshot = {
  ...BEFORE, generation: "gen-2", seq: (7 as SyncSeq),
  blocks: [{ ...BEFORE.blocks[0], text: "[[New]] edited" }],
};
// Its generation differs from the replica's, so the first pull answers
// needs-bootstrap and rebases with a preemptible flush.
const FEED: Changes = {
  reset: false, generation: "gen-2", plain_space_title_canonicalization: false,
  next_since: (7 as SyncSeq), latest_seq: (7 as SyncSeq), pages: [], blocks: [], sidebar: [],
  tombstones: [],
};

test("a batch the recovery flush got an ack for is not replayed over the snapshot", async () => {
  const t = await openRawTestDb();
  const ch = new MessageChannel();
  serveRpc(toPortLike(ch.port2), buildHandlers({
    openDb: async () => t.db, nowMs: () => 10,
  }));
  const replica = createReplica(toPortLike(ch.port1));
  const posted: string[] = [];
  const changesPaths: string[] = [];
  const sync = createReplicaSync({
    replica,
    fetchJson: async (path, init) => {
      if (path === "/api/ops") {
        posted.push(
          (JSON.parse(String(init?.body)) as { batch_id: string }).batch_id);
        return { ok: true, ts: 1, applied: 1, seq: 7, skipped: [] };
      }
      if (path === "/api/sync/snapshot") return AFTER;
      if (path.startsWith("/api/sync/changes")) {
        changesPaths.push(path);
        return FEED;
      }
      throw new Error(`unexpected fetch ${path}`);
    },
    clientId: "c1" as ClientId,
    onState: () => {},
  });

  await replica.init();
  await replica.applySnapshot(BEFORE);
  await replica.enqueue(
    [{ op: "update_text", uid: uid("uid_b1"), text: "[[Old]] edited" }], "b-rename" as BatchId);

  await sync.start();
  expect(posted).toEqual(["b-rename"]);
  expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
    .toEqual([{ text: "[[New]] edited" }]);
  expect(await replica.pendingBatches()).toEqual([]);

  // one more pull resumes from the snapshot's seq and keeps the server's text
  await sync.start();
  expect(changesPaths.at(-1)).toBe("/api/sync/changes?since=7");
  expect(t.db.select("SELECT text FROM blocks WHERE uid = 'uid_b1'"))
    .toEqual([{ text: "[[New]] edited" }]);
});
