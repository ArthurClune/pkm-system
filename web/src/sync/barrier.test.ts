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
import { batchIdOf, seqOf, uidOf } from "../test-helpers";
import { createClientRuntime } from "./clientRuntime";
import { createOutlineRepair } from "./outlineRepair";
import { memReplica } from "./memReplica";
import { createOpQueue } from "./opQueue";
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
        completeAuthoritativeRepair: () => undefined,
      },
      onSyncEvent: (event) => { events.push(event); },
      onReplicaState: () => undefined,
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
