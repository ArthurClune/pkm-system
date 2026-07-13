// The replica-backed pump: durable batches with batch_id, poison handling,
// quota degradation. The in-memory legacy path is covered in opQueue.test.ts.
import { expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { PendingBatch, Replica } from "../replica/client";
import { ReplicaError } from "../replica/rpc";
import { jsonResponse } from "../test-helpers";
import { clientId, createOpQueue } from "./opQueue";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

/** In-memory replica queue mirroring queue.ts semantics. */
function memReplica(over: Partial<Replica> = {}): Replica & { rows: PendingBatch[] } {
  const rows: PendingBatch[] = [];
  let nextId = 1;
  const pending = () => rows.filter((r) => !r.poisoned).length;
  return {
    rows,
    init: async () => ({ ok: true, empty: false, cursor: 0,
                         schemaMismatch: false, pendingBatches: [] }),
    applySnapshot: async () => undefined,
    applyChanges: async () => ({ status: "applied", cursor: 0 }),
    enqueue: async (ops) => {
      rows.push({ id: nextId, batch_id: `batch-${nextId}`, ops, poisoned: false });
      nextId += 1;
      return { pending: pending() };
    },
    nextBatch: async () => rows.find((r) => !r.poisoned) ?? null,
    pendingBatches: async () => [...rows],
    deleteBatch: async (id) => {
      rows.splice(rows.findIndex((r) => r.id === id), 1);
      return { pending: pending() };
    },
    markPoisoned: async (id) => {
      rows.find((r) => r.id === id)!.poisoned = true;
      return { pending: pending() };
    },
    pendingCount: async () => pending(),
    localApi: async () => ({ handled: false as const }),
    reset: async () => undefined,
    ...over,
  };
}

function fetchSeq(responses: Array<() => Response | Promise<Response>>) {
  const bodies: { url: string; body: unknown }[] = [];
  let call = 0;
  const mock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return make();
  });
  vi.stubGlobal("fetch", mock);
  return { bodies, mock };
}

test("drains each persisted batch as one POST carrying its batch_id", async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  const counts: number[] = [];
  q.onPending((n) => counts.push(n));
  q.enqueue([op("u1")]);
  q.enqueue([op("u2")]);
  await q.idle();
  expect(bodies.map((b) => b.body)).toEqual([
    { client_id: clientId, batch_id: "batch-1", ops: [op("u1")] },
    { client_id: clientId, batch_id: "batch-2", ops: [op("u2")] },
  ]);
  expect(replica.rows).toEqual([]);
  expect(counts.at(-1)).toBe(0);
});

test("offline: batches persist without posting; reconnect drains in order", async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2")]);
  await q.idle();
  expect(bodies).toEqual([]);
  expect(replica.rows.length).toBe(2); // durable, not dropped
  q.setOnline(true);
  await q.idle();
  expect(bodies.map((b) => (b.body as { batch_id: string }).batch_id))
    .toEqual(["batch-1", "batch-2"]);
});

test("a 4xx response poisons the batch and the queue keeps flowing", async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  const poisons: unknown[] = [];
  q.onPoison((e) => poisons.push(e));
  q.enqueue([op("bad")]);
  q.enqueue([op("good")]);
  await q.idle();
  expect(poisons.length).toBe(1);
  expect(replica.rows).toEqual([
    expect.objectContaining({ batch_id: "batch-1", poisoned: true }),
  ]);
  expect(bodies.length).toBe(2); // rejected batch + the good one
});

test("a network error keeps the batch; the next online kick retries it", async () => {
  let calls = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    calls += 1;
    if (calls === 1) throw new TypeError("network down");
    return jsonResponse({ ok: true });
  }));
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.enqueue([op("u1")]);
  await q.idle();
  expect(replica.rows.length).toBe(1); // retained
  q.setOnline(false);
  q.setOnline(true); // reconnect kick
  await q.idle();
  expect(replica.rows).toEqual([]);
});

test("quota-failed enqueue surfaces and degrades to a direct post", async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => { throw new ReplicaError("disk full", true); },
  });
  const q = createOpQueue(replica, () => undefined);
  const quotas: unknown[] = [];
  q.onQuota((e) => quotas.push(e));
  q.enqueue([op("u1")]);
  await q.idle();
  expect(quotas.length).toBe(1);
  // best-effort legacy post so the edit still lands while online
  expect(bodies[0].body).toEqual({ client_id: clientId, ops: [op("u1")] });
});

test("other replica enqueue failures report desync", async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => { throw new Error("worker crashed"); },
  });
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  q.enqueue([op("u1")]);
  await q.idle();
  expect(desyncs.length).toBe(1);
});
