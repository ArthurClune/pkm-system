// The replica-backed pump: durable batches with batch_id, poison handling,
// quota degradation. The in-memory legacy path is covered in opQueue.test.ts.
import { beforeEach, expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { PendingBatch, Replica } from "../replica/client";
import { ReplicaError } from "../replica/rpc";
import { jsonResponse } from "../test-helpers";
import { clientId, createOpQueue, type PoisonEvent } from "./opQueue";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

beforeEach(() => { localStorage.clear(); });

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
      const batchId = `batch-${nextId}`;
      rows.push({ id: nextId, batch_id: batchId, ops, poisoned: false });
      nextId += 1;
      return { pending: pending(), batchId };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
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
  const body = bodies[0].body as { client_id: string; batch_id?: string; ops: unknown[] };
  expect(body.client_id).toBe(clientId);
  expect(body.batch_id).toBeDefined();
  expect(body.ops).toEqual([op("u1")]);
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

test("a write ticket reports delivery only after its durable batch is acknowledged", async () => {
  let release!: () => void;
  const posted = new Promise<void>((done) => { release = done; });
  fetchSeq([async () => {
    await posted;
    return jsonResponse({ ok: true });
  }]);
  const q = createOpQueue(memReplica(), () => undefined);

  const ticket = q.enqueue([op("u1")], ["page", "Page"]);
  await ticket.settled;
  let delivered = false;
  void ticket.delivered.then(() => { delivered = true; });
  await Promise.resolve();
  expect(delivered).toBe(false);

  release();
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("an unkeyed earlier ticket resolves before a later batch retries", async () => {
  const replica = memReplica();
  const enqueue = replica.enqueue.bind(replica);
  replica.enqueue = async (ops) => {
    const result = await enqueue(ops);
    return { pending: result.pending };
  };
  fetchSeq([
    () => jsonResponse({ ok: true }),
    () => jsonResponse({ detail: "busy" }, 503),
  ]);
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);
  const first = q.enqueue([op("first")]);
  const second = q.enqueue([op("second")]);
  await q.settled();
  q.setOnline(true);
  await expect(q.drain()).resolves.toMatchObject({ reason: "retryable" });

  let firstOutcome: unknown;
  let secondOutcome: unknown;
  void first.delivered.then((outcome) => { firstOutcome = outcome; });
  void second.delivered.then((outcome) => { secondOutcome = outcome; });
  await Promise.resolve();
  expect(firstOutcome).toEqual({ status: "delivered" });
  expect(secondOutcome).toBeUndefined();
  q.dispose();
});

test("an unkeyed ticket receives its matching 4xx terminal outcome", async () => {
  const replica = memReplica();
  const enqueue = replica.enqueue.bind(replica);
  replica.enqueue = async (ops) => {
    const result = await enqueue(ops);
    return { pending: result.pending };
  };
  fetchSeq([() => jsonResponse({ detail: "bad op" }, 400)]);
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);
  const rejected = q.enqueue([op("bad")]);
  const later = q.enqueue([op("later")]);
  await q.settled();
  q.setOnline(true);
  await expect(q.drain()).resolves.toMatchObject({ reason: "recovering" });

  let rejectedOutcome: unknown;
  let laterOutcome: unknown;
  void rejected.delivered.then((outcome) => { rejectedOutcome = outcome; });
  void later.delivered.then((outcome) => { laterOutcome = outcome; });
  await Promise.resolve();
  expect(rejectedOutcome).toMatchObject({ status: "failed" });
  expect(laterOutcome).toBeUndefined();
  q.dispose();
});

test("dispose during replica persistence settles delivery exactly once", async () => {
  const persisted = deferred<{ pending: number; batchId?: string }>();
  const replica = memReplica({ enqueue: () => persisted.promise });
  const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  const q = createOpQueue(replica, () => undefined);
  const write = q.enqueue([op("slow")]);
  await Promise.resolve();

  q.dispose();
  persisted.resolve({ pending: 1, batchId: "batch-slow" });

  await expect(write.settled).resolves.toEqual({ status: "persisted", pending: 1 });
  let delivery: unknown;
  let deliveries = 0;
  void write.delivered.then((outcome) => {
    delivery = outcome;
    deliveries += 1;
  });
  await Promise.resolve();
  expect(delivery).toMatchObject({ status: "failed" });
  expect(deliveries).toBe(1);
  expect(fetchMock).not.toHaveBeenCalled();
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
  const markFailed = vi.fn();
  q.onPoisonPending(pending);
  q.onPoisonMarkFailed(markFailed);
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
  expect(markFailed).toHaveBeenCalledWith({
    event: expect.objectContaining({ rowId: 1, batchId: "batch-1" }),
    error,
  });
  expect(desync).not.toHaveBeenCalled();
  q.dispose();
});

test("mark failure Retry durably marks without re-POSTing then publishes poison",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({}, 400)]);
  const error = new Error("poison RPC failed");
  let markAttempts = 0;
  const replica = memReplica({
    markPoisoned: async (id) => {
      markAttempts += 1;
      if (markAttempts === 1) throw error;
      replica.rows.find((row) => row.id === id)!.poisoned = true;
      return { pending: replica.rows.filter((row) => !row.poisoned).length };
    },
  });
  const q = createOpQueue(replica, () => undefined);
  const markFailures: unknown[] = [];
  const poisons: PoisonEvent[] = [];
  const recovery = q as unknown as {
    onPoisonMarkFailed?: (fn: (failure: unknown) => void) => () => void;
    retryPoisonMarks?: () => Promise<readonly PoisonEvent[]>;
  };
  recovery.onPoisonMarkFailed?.((failure) => markFailures.push(failure));
  q.onPoison((event) => poisons.push(event));

  q.enqueue([op("bad")]);
  q.enqueue([op("good")]);
  await q.settled();
  await q.drain();

  expect(recovery.onPoisonMarkFailed).toBeTypeOf("function");
  expect(recovery.retryPoisonMarks).toBeTypeOf("function");
  expect(markFailures).toEqual([{
    event: expect.objectContaining({ rowId: 1, batchId: "batch-1" }),
    error,
  }]);
  expect(poisons).toEqual([]);
  expect(markAttempts).toBe(1);
  expect(bodies).toHaveLength(1);

  await recovery.retryPoisonMarks?.();

  expect(markAttempts).toBe(2);
  expect(poisons).toEqual([
    expect.objectContaining({ rowId: 1, batchId: "batch-1" }),
  ]);
  expect(bodies).toHaveLength(1); // Retry only marks; it never calls /api/ops
  expect(replica.rows).toEqual([
    expect.objectContaining({ id: 1, poisoned: true }),
    expect.objectContaining({ id: 2, poisoned: false }),
  ]);
});

test("a reload restores mark intent and blocks delivery until marking succeeds",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({}, 400)]);
  let markAttempts = 0;
  const replica = memReplica({
    markPoisoned: async (id) => {
      markAttempts += 1;
      if (markAttempts === 1) throw new Error("worker disappeared");
      replica.rows.find((row) => row.id === id)!.poisoned = true;
      return { pending: replica.rows.filter((row) => !row.poisoned).length };
    },
  });
  const firstPage = createOpQueue(replica, () => undefined);
  firstPage.enqueue([op("bad")]);
  firstPage.enqueue([op("good")]);
  await firstPage.settled();
  await firstPage.drain();
  firstPage.dispose();

  const reloaded = createOpQueue(replica, () => undefined);
  const poisons: PoisonEvent[] = [];
  reloaded.onPoison((event) => poisons.push(event));
  const recovery = reloaded as unknown as {
    poisonMarkIntents?: () => readonly PoisonEvent[];
    retryPoisonMarks?: () => Promise<readonly PoisonEvent[]>;
  };

  await expect(reloaded.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 2,
  });
  expect(bodies).toHaveLength(1); // reload did not resend rejected or later work
  expect(markAttempts).toBe(1);
  expect(recovery.poisonMarkIntents?.()).toEqual([
    expect.objectContaining({ rowId: 1, batchId: "batch-1" }),
  ]);

  await recovery.retryPoisonMarks?.();

  expect(markAttempts).toBe(2);
  expect(bodies).toHaveLength(1);
  expect(poisons).toEqual([
    expect.objectContaining({ rowId: 1, batchId: "batch-1" }),
  ]);
});

test("retained mark intents are deduplicated and retried oldest-first", async () => {
  const first: PoisonEvent = {
    rowId: 1, batchId: "batch-1", ops: [op("first")], status: 400,
    message: "first rejected",
  };
  const second: PoisonEvent = {
    rowId: 2, batchId: "batch-2", ops: [op("second")], status: 422,
    message: "second rejected",
  };
  localStorage.setItem("pkm.poison-mark-intents.v1", JSON.stringify({
    version: 1, intents: [second, first, second],
  }));
  const replica = memReplica();
  replica.rows.push(
    { id: 1, batch_id: "batch-1", ops: [op("first")], poisoned: false },
    { id: 2, batch_id: "batch-2", ops: [op("second")], poisoned: false },
  );
  const marked: number[] = [];
  replica.markPoisoned = async (id) => {
    marked.push(id);
    replica.rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: replica.rows.filter((row) => !row.poisoned).length };
  };
  const q = createOpQueue(replica, () => undefined);
  const published: PoisonEvent[] = [];
  q.onPoison((event) => published.push(event));
  const recovery = q as unknown as {
    poisonMarkIntents(): readonly PoisonEvent[];
    retryPoisonMarks(): Promise<readonly PoisonEvent[]>;
  };

  expect(recovery.poisonMarkIntents()).toEqual([first, second]);
  await recovery.retryPoisonMarks();

  expect(marked).toEqual([1, 2]);
  expect(published).toEqual([first, second]);
  expect(localStorage.getItem("pkm.poison-mark-intents.v1")).toBeNull();
});

test("a stale post-mark intent is retried idempotently without delivery", async () => {
  const event: PoisonEvent = {
    rowId: 1, batchId: "batch-1", ops: [op("bad")], status: 400,
    message: "request failed: 400 /api/ops",
  };
  localStorage.setItem("pkm.poison-mark-intents.v1", JSON.stringify({
    version: 1, intents: [event],
  }));
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  replica.rows.push({
    id: 1, batch_id: "batch-1", ops: [op("bad")], poisoned: true,
  });
  const mark = vi.fn(async () => ({ pending: 0 }));
  replica.markPoisoned = mark;
  const q = createOpQueue(replica, () => undefined);
  const recovery = q as unknown as {
    retryPoisonMarks(): Promise<readonly PoisonEvent[]>;
  };

  await expect(q.drain()).resolves.toMatchObject({ reason: "recovering" });
  await recovery.retryPoisonMarks();

  expect(mark).toHaveBeenCalledWith(1, expect.any(String), "batch-1");
  expect(bodies).toEqual([]);
});

test("a retained intent cannot poison a reused row id from another batch",
async () => {
  const stale: PoisonEvent = {
    rowId: 1, batchId: "deleted-batch", ops: [op("old")], status: 400,
    message: "old rejection",
  };
  localStorage.setItem("pkm.poison-mark-intents.v1", JSON.stringify({
    version: 1, intents: [stale],
  }));
  const replica = memReplica();
  replica.rows.push({
    id: 1, batch_id: "replacement-batch", ops: [op("new")], poisoned: false,
  });
  const mark = vi.fn(async (id: number, _error: string, batchId?: string) => {
    const row = replica.rows.find((candidate) =>
      candidate.id === id && candidate.batch_id === batchId);
    if (row) row.poisoned = true;
    return {
      pending: replica.rows.filter((candidate) => !candidate.poisoned).length,
      matched: row !== undefined,
    };
  });
  (replica as unknown as { markPoisoned: typeof mark }).markPoisoned = mark;
  const q = createOpQueue(replica, () => undefined);
  const published: PoisonEvent[] = [];
  q.onPoison((event) => published.push(event));

  await expect(q.retryPoisonMarks()).resolves.toEqual([]);

  expect(mark).toHaveBeenCalledWith(1, expect.any(String), "deleted-batch");
  expect(replica.rows[0]).toMatchObject({
    batch_id: "replacement-batch", poisoned: false,
  });
  expect(q.poisonMarkIntents()).toEqual([]);
  expect(published).toEqual([]);
});

test("corrupt retained mark metadata is ignored safely", async () => {
  localStorage.setItem("pkm.poison-mark-intents.v1", "{not-json");
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.enqueue([op("good")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies).toHaveLength(1);
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
