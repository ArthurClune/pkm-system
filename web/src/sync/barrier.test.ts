// @vitest-environment node
// The queue's recovery barrier with its owners composed as the sync session
// (session.ts) composes them: the real queue, the client runtime's poison
// repair and the outline repair, over an in-memory replica and a recording
// POST. Each test leaves one owner's claim standing while another owner lets
// go of its own, and reads back what reached the server.
import { describe, expect, test } from "vitest";
import { ApiError } from "../api/client";
import type { BatchId } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { OpBatch, OpsAck } from "../api/payloads";
import { MAX_BLOCK_TEXT_CHARS } from "../grammar/textLimits";
import type { Replica } from "../replica/client";
import { batchIdOf, clientIdOf, seqOf, uidOf } from "../test-helpers";
import { createClientRuntime } from "./clientRuntime";
import { createOutlineRepair } from "./outlineRepair";
import { memReplica } from "./memReplica";
import { createOpQueue } from "./opQueue";
import { createReplicaSync, type ReplicaSyncDeps } from "./replicaSync";
import type { SyncEvent } from "./syncState";

const op = (rawUid: string): BlockOp => ({ op: "delete", uid: uidOf(rawUid) });
const overLimit: BlockOp = {
  op: "update_text", uid: uidOf("tuid-big"),
  text: "x".repeat(MAX_BLOCK_TEXT_CHARS + 1),
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** A POST that records each batch id and rejects the ones in `bad` with a
 * 400, as the server rejects a batch outright. */
function recordingPost(bad: Set<BatchId>) {
  const posted: BatchId[] = [];
  const post = async (body: OpBatch): Promise<OpsAck> => {
    posted.push(body.batch_id);
    if (bad.has(body.batch_id)) throw new ApiError(400, "/api/ops", "bad batch");
    return { ok: true, ts: 1, applied: 1, seq: seqOf(1) };
  };
  return { posted, post };
}

describe("one owner's resume leaves another's claim standing", () => {
  test("a local refusal's outline repair does not lift the poison repair's barrier",
       async () => {
    const bad = new Set<BatchId>();
    const { posted, post } = recordingPost(bad);
    const replica = memReplica();
    const queue = createOpQueue(replica, { post });
    const events: SyncEvent[] = [];
    const runtime = createClientRuntime({
      queue,
      replica,
      replicaSync: {
        start: async () => undefined,
        // The poison repair's snapshot fetch fails: its Retry banner stays.
        rebaseAuthoritative: async () => { throw new TypeError("fetch failed"); },
        noteUnavailable: () => undefined,
      },
      onSyncEvent: (event) => { events.push(event); },
    });
    const outline = createOutlineRepair({
      repairSessions: async (onStable) => { onStable(); },
      onEvent: (event) => { events.push(event); },
      resume: () => queue.resume("lane"),
      isMounted: () => true,
    });
    queue.onDesync((desync) => { void outline.run(desync.error, desync); });
    await runtime.startup();
    queue.setOnline(true);

    const rejected = queue.enqueue([op("tuid-a")]);
    queue.enqueue([op("tuid-b")]);
    await queue.settled();
    bad.add(replica.enqueued[0]);
    await queue.drain();
    await rejected.delivered;
    await flush();
    expect(events.at(-1)).toMatchObject({ type: "repair-failed" });

    queue.enqueue([overLimit]);
    await queue.settled();
    await flush();
    await queue.drain();
    await flush();

    expect(posted).toEqual([replica.enqueued[0]]);
  });

  test("a recovery's resume does not lift a lane repair that is still reading",
       async () => {
    const bad = new Set<BatchId>();
    const { posted, post } = recordingPost(bad);
    const replica = memReplica({
      enqueue: async () => { throw new Error("SQLITE_IOERR"); },
    });
    const ids: BatchId[] = [];
    let minted = 0;
    const queue = createOpQueue(replica, {
      post,
      newBatchId: () => {
        minted += 1;
        const id = batchIdOf(`lane-${minted}`);
        ids.push(id);
        return id;
      },
    });
    const reading = deferred();
    const outline = createOutlineRepair({
      repairSessions: async (onStable) => { await reading.promise; onStable(); },
      onEvent: () => undefined,
      resume: () => queue.resume("lane"),
      isMounted: () => true,
    });
    queue.onDesync((desync) => { void outline.run(desync.error, desync); });

    queue.enqueue([op("tuid-a")]);
    queue.enqueue([op("tuid-b")]);
    await queue.settled();
    bad.add(ids[0]);
    await queue.drain();
    await flush();
    expect(posted).toEqual([ids[0]]);

    // A normal recovery (replicaSync's runRecovery) runs and ends while the
    // outline repair is still reading.
    queue.pause("recovery");
    queue.resume("recovery");
    await queue.drain();
    await flush();
    expect(posted).toEqual([ids[0]]);

    reading.resolve();
    await flush();
    await queue.drain();
    expect(posted).toEqual([ids[0], ids[1]]);
  });
});

describe("the poison claim under a discard", () => {
  const SNAPSHOT = { generation: "g1", seq: 5, pages: [], blocks: [], sidebar: [] };
  const feed = (latest: number) => ({
    reset: false, generation: "g1", next_since: latest, latest_seq: latest,
    pages: [], blocks: [], sidebar: [], tombstones: [],
  });
  const fetchJson: ReplicaSyncDeps["fetchJson"] = async (path) =>
    path.startsWith("/api/sync/snapshot") ? SNAPSHOT : feed(5);

  /** The queue, the replica sync and the runtime, wired as the session
   * wires them. */
  function wire(replica: Replica, post: (body: OpBatch) => Promise<OpsAck>) {
    const queue = createOpQueue(replica, { post });
    const replicaSync = createReplicaSync({
      replica, fetchJson, clientId: clientIdOf("barrier-test"), queue,
      holdsPoison: () => queue.holds("poison"),
      onState: () => undefined,
    });
    const runtime = createClientRuntime({
      queue, replica, replicaSync,
      onSyncEvent: () => undefined,
    });
    return { queue, replicaSync, runtime };
  }

  test("a reset and a pass needing recovery wait for a repair whose change " +
       "was discarded", async () => {
    const bad = new Set<BatchId>();
    const { post } = recordingPost(bad);
    const lease = deferred();
    let leases = 0;
    let needsBootstrap = false;
    const base = memReplica();
    const replica = memReplica({
      prepareRecovery: async () => {
        leases += 1;
        if (leases === 1) await lease.promise;
        return base.prepareRecovery();
      },
      applyChanges: async (window) => needsBootstrap
        ? { status: "needs-bootstrap" }
        : { status: "applied", cursor: window.next_since },
    });
    const { queue, replicaSync, runtime } = wire(replica, post);
    await runtime.startup();
    queue.setOnline(true);

    queue.enqueue([op("tuid-a")]);
    await queue.settled();
    bad.add(replica.enqueued[0]);
    await queue.drain();
    await flush();
    expect(leases).toBe(1);

    await runtime.discardPoisonIntents();
    await expect(replicaSync.resetLocalData({ discardPending: true }))
      .rejects.toThrow("rejected-batch repair in progress");
    needsBootstrap = true;
    replicaSync.onSeq(seqOf(9));
    await flush();
    expect(leases).toBe(1);

    lease.resolve();
    await flush();
    await replicaSync.idle();
    expect(leases).toBe(2);
    expect(queue.holds("poison")).toBe(false);
  });
});
