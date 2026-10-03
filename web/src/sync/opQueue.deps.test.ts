// @vitest-environment node
// createOpQueue's optional deps: an injected transport, client id, poison
// store and batch-id minter replace the module defaults without any fetch or
// localStorage involvement.
import { describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { OpsAck, OpBatch } from "../api/payloads";
import type { PendingRowId } from "../replica/client";
import { uid } from "../test-helpers";
import { memReplica } from "./memReplica";
import { createOpQueue, type PoisonIntentStore } from "./opQueue";
import type { PoisonEvent } from "./poisonIntents";

const op = (rawUid: string): BlockOp => ({ op: "delete", uid: uid(rawUid) });
const ack = (): OpsAck => ({
  applied: true, seq: 1 as SyncSeq,
} as unknown as OpsAck);

function minter(): () => BatchId {
  let n = 0;
  return () => { n += 1; return `batch-${n}` as BatchId; };
}

function memStore(initial: PoisonEvent[] = []) {
  const writes: PoisonEvent[][] = [];
  const store: PoisonIntentStore = {
    read: () => initial,
    write: (intents) => { writes.push([...intents]); },
  };
  return { store, writes };
}

describe("createOpQueue deps", () => {
  test("posts through deps.post with the injected client and batch ids", async () => {
    const post = vi.fn(async (_body: OpBatch) => ack());
    const q = createOpQueue(memReplica(), {
      post, clientId: "client-x" as ClientId, newBatchId: minter(),
    });
    await q.enqueue([op("aaaaaaaa")]).settled;
    await q.drain();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      client_id: "client-x", batch_id: "batch-1", ops: [op("aaaaaaaa")],
    });
    q.dispose();
  });

  test("reads and writes poison intents through deps.poisonStore", async () => {
    const stored: PoisonEvent = {
      id: 7 as PendingRowId, batch_id: "old-batch" as BatchId, ops: [op("bbbbbbbb")],
      status: 400, message: "bad",
    };
    const { store, writes } = memStore([stored]);
    const replica = memReplica({
      markPoisoned: vi.fn(async () => ({ pending: 0, matched: false })),
    });
    const post = vi.fn(async (_body: OpBatch): Promise<OpsAck> => {
      throw new ApiError(400, "/api/ops");
    });
    const q = createOpQueue(replica, {
      post, poisonStore: store, newBatchId: minter(),
    });
    expect(q.poisonMarkIntents()).toEqual([stored]);
    await q.retryPoisonMarks();
    expect(replica.markPoisoned).toHaveBeenCalledWith(
      7, expect.any(String), "old-batch");
    expect(writes.at(-1)).toEqual([]);

    q.dispose();

    const fresh = memStore();
    const rejecting = createOpQueue(memReplica(), {
      post, poisonStore: fresh.store, newBatchId: minter(),
    });
    await rejecting.enqueue([op("cccccccc")]).settled;
    await rejecting.drain();
    // The intent is retained, then cleared once the replica row is marked.
    expect(fresh.writes.some((w) => w.some((e) => e.batch_id === "batch-1")))
      .toBe(true);
    rejecting.dispose();
    expect(globalThis.localStorage?.getItem("pkm.poison-mark-intents.v1") ?? null)
      .toBeNull();
  });

  test("two queues with different deps do not share ids", async () => {
    const postA = vi.fn(async (_body: OpBatch) => ack());
    const postB = vi.fn(async (_body: OpBatch) => ack());
    const a = createOpQueue(memReplica(), {
      post: postA, clientId: "client-a" as ClientId, newBatchId: minter(),
    });
    const b = createOpQueue(memReplica(), {
      post: postB, clientId: "client-b" as ClientId, newBatchId: minter(),
    });
    await a.enqueue([op("aaaaaaaa")]).settled;
    await b.enqueue([op("bbbbbbbb")]).settled;
    await a.drain();
    await b.drain();
    expect(postA.mock.calls.map(([body]) => body.client_id)).toEqual(["client-a"]);
    expect(postB.mock.calls.map(([body]) => body.client_id)).toEqual(["client-b"]);
    a.dispose();
    b.dispose();
  });
});
