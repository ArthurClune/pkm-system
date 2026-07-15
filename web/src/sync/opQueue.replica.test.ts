// The replica-backed pump: durable batches with batch_id, poison handling,
// quota degradation. The in-memory legacy path is covered in opQueue.test.ts.
import { expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { PendingBatch, Replica } from "../replica/client";
import { ReplicaError } from "../replica/rpc";
import { jsonResponse } from "../test-helpers";
import { clientId, createOpQueue, type PoisonEvent } from "./opQueue";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

/** In-memory replica queue mirroring queue.ts semantics. */
function memReplica(over: Partial<Replica> = {}): Replica & { rows: PendingBatch[] } {
  const rows: PendingBatch[] = [];
  let nextId = 1;
  const pending = () => rows.filter((r) => !r.poisoned).length;
  const replica: Replica & { rows: PendingBatch[] } = {
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
    poisonedBatches: async () => [],
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
    prepareRecovery: async () => ({ token: "lease-1", batches: [...rows] }),
    commitRecovery: async () => undefined,
    abortRecovery: async () => undefined,
    reset: async () => undefined,
    dispose: async () => undefined,
  };
  return Object.assign(replica, over);
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
  await q.settled();
  await q.drain();
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
  await q.settled();
  await q.drain();
  expect(bodies).toEqual([]);
  expect(replica.rows.length).toBe(2); // durable, not dropped
  q.setOnline(true);
  await q.settled();
  await q.drain();
  expect(bodies.map((b) => (b.body as { batch_id: string }).batch_id))
    .toEqual(["batch-1", "batch-2"]);
});

test("a 4xx emits batch details and pauses later delivery before notifying", async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  const poisons: PoisonEvent[] = [];
  q.onPoison((event) => poisons.push(event));
  q.enqueue([op("bad")]);
  q.enqueue([op("good")]);
  await q.settled();
  const outcome = await q.drain();
  expect(poisons).toEqual([{
    rowId: 1,
    batchId: "batch-1",
    ops: [op("bad")],
    status: 400,
    message: "request failed: 400 /api/ops",
  }]);
  expect(outcome).toMatchObject({ status: "blocked", reason: "recovering" });
  expect(replica.rows).toEqual([
    expect.objectContaining({ batch_id: "batch-1", poisoned: true }),
    expect.objectContaining({ batch_id: "batch-2", poisoned: false }),
  ]);
  expect(bodies).toHaveLength(1); // the good batch waits for repair

  q.resume("recovery");
  await q.drain();
  expect(bodies).toHaveLength(2);
});

test("a 4xx raises the internal poison barrier before durable mark resolves", async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  let releaseMark!: () => void;
  const markGate = new Promise<void>((resolve) => { releaseMark = resolve; });
  let markStarted!: () => void;
  const marking = new Promise<void>((resolve) => { markStarted = resolve; });
  const replica = memReplica({
    markPoisoned: async (id) => {
      markStarted();
      await markGate;
      replica.rows.find((row) => row.id === id)!.poisoned = true;
      return { pending: replica.rows.filter((row) => !row.poisoned).length };
    },
  });
  const q = createOpQueue(replica, () => undefined);
  let pendingSignals = 0;
  const publicEvents: PoisonEvent[] = [];
  q.onPoisonPending(() => { pendingSignals += 1; });
  q.onPoison((event) => publicEvents.push(event));

  q.enqueue([op("bad")]);
  q.enqueue([op("good")]);
  await marking;
  const observedWhileMarkBlocked = {
    pendingSignals,
    publicEvents: [...publicEvents],
    postedBatchIds: bodies.map((body) =>
      (body.body as { batch_id: string }).batch_id),
  };
  releaseMark();
  await q.drain();

  expect(q.onPoisonPending).toBeTypeOf("function");
  expect(observedWhileMarkBlocked).toEqual({
    pendingSignals: 1,
    publicEvents: [], // public details follow durable mark
    postedBatchIds: ["batch-1"],
  });
  expect(publicEvents).toHaveLength(1);
  expect(bodies.map((body) => (body.body as { batch_id: string }).batch_id))
    .toEqual(["batch-1"]); // rejected exactly once; later batch still held
});

test("a durable batch from a previous page load drains on the first connect", async () => {
  // a reload can kill an in-flight POST: the batch survives in the replica,
  // and the first socket connect of the next session must drain it even
  // though the queue never saw a setOnline(false)
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  replica.rows.push({ id: 99, batch_id: "leftover", ops: [op("u1")],
                      poisoned: false });
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(true); // the socket's first connect after the reload
  await q.settled();
  await q.drain();
  expect(bodies.map((b) => (b.body as { batch_id: string }).batch_id))
    .toEqual(["leftover"]);
  expect(replica.rows).toEqual([]);
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
  await q.settled();
  await q.drain();
  expect(replica.rows.length).toBe(1); // retained
  q.setOnline(false);
  q.setOnline(true); // reconnect kick
  await q.settled();
  await q.drain();
  expect(replica.rows).toEqual([]);
});

test("a slow drain POST does not delay persisting later edits", async () => {
  // durability must never wait on the network: if it did, a reload during
  // one slow POST would lose every edit made behind it
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  vi.stubGlobal("fetch", vi.fn(async () => {
    await gate;
    return jsonResponse({ ok: true });
  }));
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.enqueue([op("u1")]);
  await vi.waitFor(() => { expect(replica.rows.length).toBe(1); });
  q.enqueue([op("u2")]); // first POST still in flight
  await vi.waitFor(() => { expect(replica.rows.length).toBe(2); });
  release();
  await q.settled();
  await q.drain();
  expect(replica.rows).toEqual([]); // both drained once the network freed up
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
  await q.settled();
  await q.drain();
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
  await q.settled();
  await q.drain();
  expect(desyncs.length).toBe(1);
});

test("offline enqueue settles as persisted while drain reports blocked", async () => {
  const { mock } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  const ticket = q.enqueue([op("u1")], ["page", "Page"]);

  await expect(ticket.settled).resolves.toEqual({ status: "persisted", pending: 1 });
  expect(ticket.scope).toEqual(["page", "Page"]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 1,
  });
  expect(mock).not.toHaveBeenCalled();
});

test("a transient 503 returns retryable then the 250ms retry drains", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ detail: "busy" }, 503)
        : jsonResponse({ ok: true });
    }));
    const replica = memReplica();
    const q = createOpQueue(replica, () => undefined);
    await q.enqueue([op("u1")]).settled;

    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "retryable", pending: 1,
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });
    await expect(replica.pendingCount()).resolves.toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test("dispose cancels retry and reports the retained durable batch", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi.fn(async () => jsonResponse({ detail: "busy" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const replica = memReplica();
    const q = createOpQueue(replica, () => undefined);
    await q.enqueue([op("u1")]).settled;
    await expect(q.drain()).resolves.toMatchObject({ reason: "retryable" });

    q.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(q.drain()).resolves.toEqual({
      status: "blocked", reason: "disposed", pending: 1,
    });
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ["nextBatch", 200,
    { nextBatch: async () => { throw new Error("next RPC failed"); } }],
  ["deleteBatch", 200,
    { deleteBatch: async () => { throw new Error("delete RPC failed"); } }],
] as const)("%s RPC failure fulfills drain with a retryable outcome",
async (_method, status, over) => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, status)));
  const replica = memReplica(over);
  const q = createOpQueue(replica, () => undefined);

  const write = q.enqueue([op("u1")]);
  const outcome = q.drain();
  await write.settled;

  await expect(outcome).resolves.toMatchObject({
    status: "blocked", reason: "retryable", pending: 1,
  });
  q.dispose();
});

test("markPoisoned RPC failure preserves the barrier without re-POSTing",
async () => {
  const fetchMock = vi.fn(async () => jsonResponse({}, 400));
  vi.stubGlobal("fetch", fetchMock);
  const error = new Error("poison RPC failed");
  const replica = memReplica({
    markPoisoned: async () => { throw error; },
  });
  const desync = vi.fn();
  const q = createOpQueue(replica, desync);
  const pending = vi.fn();
  const published = vi.fn();
  q.onPoisonPending(pending);
  q.onPoison(published);

  const write = q.enqueue([op("u1")]);
  const outcome = q.drain();
  await write.settled;

  await expect(outcome).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 1, error,
  });
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 1,
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(pending).toHaveBeenCalledTimes(1);
  expect(published).not.toHaveBeenCalled();
  expect(desync).toHaveBeenCalledWith(error);
  q.dispose();
});

test("an automatic drain RPC failure is observed without an unhandled rejection", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true })));
  const error = new Error("delete RPC failed");
  const observed = vi.fn();
  const replica = memReplica({
    deleteBatch: async () => { throw error; },
  });
  const q = createOpQueue(replica, () => undefined, observed);

  await q.enqueue([op("u1")]).settled;

  await vi.waitFor(() => {
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      status: "blocked", reason: "retryable", error,
    }));
  }, { timeout: 100 });
  q.dispose();
});

test("replica retry delays are 250ms, 1s, then 5s capped and success resets", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls <= 4 || calls === 6
        ? jsonResponse({ detail: "busy" }, 503)
        : jsonResponse({ ok: true });
    }));
    const replica = memReplica();
    const q = createOpQueue(replica, () => undefined);
    await q.enqueue([op("u1")]).settled;
    await q.drain();

    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toBe(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(5);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });

    await q.enqueue([op("u2")]).settled;
    await q.drain();
    expect(calls).toBe(6);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(7);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });
  } finally {
    vi.useRealTimers();
  }
});

test.each([
  ["offline", (q: ReturnType<typeof createOpQueue>) => q.setOnline(false)],
  ["recovering", (q: ReturnType<typeof createOpQueue>) => q.pause("recovery")],
  ["disposed", (q: ReturnType<typeof createOpQueue>) => q.dispose()],
] as const)("replica failure returns the current %s terminal state",
async (reason, transition) => {
  let rejectPost!: (error: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => {
    rejectPost = reject;
  })));
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  const write = q.enqueue([op("u1")]);
  await write.settled;
  await vi.waitFor(() => { expect(fetch).toHaveBeenCalledTimes(1); });
  const outcome = q.drain();

  transition(q);
  rejectPost(new TypeError("network failed"));

  await expect(outcome).resolves.toMatchObject({
    status: "blocked", reason, pending: 1,
  });
  q.dispose();
});
