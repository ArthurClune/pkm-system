// The queue: durable batches with batch_id, poison handling, retention of
// failed local persistence, and the connectivity/backoff/recovery policy every
// drain obeys. The fake Replica it drives lives in ./memReplica.
import { beforeEach, expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import type { Replica } from "../replica/client";
import { ReplicaError, ReplicaUnavailableError,
         RpcLifecycleError } from "../replica/errors";
import { jsonResponse } from "../test-helpers";
import { memReplica } from "./memReplica";
import { clientId, createOpQueue, type PoisonEvent } from "./opQueue";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

beforeEach(() => { localStorage.clear(); });

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

/** The exhausted-SAH-pool shape (pkm-ndcu): local storage is unavailable, and
 * that is never a server rejection. */
const CANTOPEN =
  "SQLITE_CANTOPEN: sqlite3 result code 14: unable to open database file";

/** A queue whose local persistence always fails, so every enqueue lands in the
 * in-memory lane. */
const laneOnlyReplica = (over: Partial<Replica> = {}) => memReplica({
  enqueue: async () => { throw new Error(CANTOPEN); },
  ...over,
});

test("clientId is stable and uid-shaped", () => {
  expect(clientId).toMatch(/^[a-zA-Z0-9_-]{6,32}$/);
});

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
    { client_id: clientId, batch_id: replica.enqueued[0], ops: [op("u1")] },
    { client_id: clientId, batch_id: replica.enqueued[1], ops: [op("u2")] },
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
    .toEqual(replica.enqueued);
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
    batchId: replica.enqueued[0],
    ops: [op("bad")],
    status: 400,
    message: "request failed: 400 /api/ops: bad op",
  }]);
  expect(outcome).toMatchObject({ status: "blocked", reason: "recovering" });
  expect(replica.rows).toEqual([
    expect.objectContaining({ batch_id: replica.enqueued[0], poisoned: true }),
    expect.objectContaining({ batch_id: replica.enqueued[1], poisoned: false }),
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
      return {
        pending: replica.rows.filter((row) => !row.poisoned).length,
        matched: true,
      };
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
    postedBatchIds: [replica.enqueued[0]],
  });
  expect(publicEvents).toHaveLength(1);
  expect(bodies.map((body) => (body.body as { batch_id: string }).batch_id))
    .toEqual([replica.enqueued[0]]); // rejected exactly once; later batch still held
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

test("a disk-full enqueue is retained for ordered delivery", async () => {
  // An exhausted disk reaches the queue as a bare SQLITE_IOERR — the
  // opfs-sahpool VFS swallows the QuotaExceededError DOMException — so there
  // is no storage-specific handling to test, only retention (pkm-avag).
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => {
      throw new ReplicaError("SQLITE_IOERR: disk I/O error");
    },
  });
  const q = createOpQueue(replica, () => undefined);
  q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  // retained in memory, then delivered by the drain under queue policy
  const body = bodies[0].body as { client_id: string; batch_id?: string; ops: unknown[] };
  expect(body.client_id).toBe(clientId);
  expect(body.batch_id).toBeDefined();
  expect(body.ops).toEqual([op("u1")]);
});

test("an OPFS access-handle contention enqueue failure is retained, not desynced", async () => {
  // A page reload (or the e2e's per-navigation worker churn) can leave the
  // prior worker's OPFS SAH pool briefly locked, so replica.enqueue rejects
  // with the sqlite-wasm "createSyncAccessHandle" contention error. That is a
  // local-storage problem, never a server rejection: the edit must still be
  // delivered online — through the drain, so it cannot overtake older batches
  // or ignore backoff — and onDesync (which would wipe the active outline)
  // must NOT fire (pkm-c9hp).
  //
  // The REASON this passes changed in pkm-s7af: it is no longer that this
  // message is on a retention allowlist, but that the replica did not report
  // the failure as a rejection of the op. The message is now incidental.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => {
      throw new Error(
        "Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle':"
        + " Access Handles cannot be created if there is another open Access"
        + " Handle or Writable stream associated with the same file.");
    },
  });
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  expect(desyncs).toEqual([]); // no spurious desync repair / outline wipe
  const body = bodies[0].body as { client_id: string; batch_id?: string; ops: unknown[] };
  expect(body.client_id).toBe(clientId);
  expect(body.batch_id).toBeDefined();
  expect(body.ops).toEqual([op("u1")]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("an exhausted SAH pool enqueue failure is retained, not desynced", async () => {
  // A pool that raced its way to a single slot holds the database file and
  // nothing else, so SQLite cannot create the rollback journal a write
  // transaction needs and every enqueue fails with SQLITE_CANTOPEN
  // (pkm-ndcu). Like access-handle contention this is purely local: it must
  // deliver online — through the drain, so it cannot overtake older batches or
  // ignore backoff — and must NOT fire onDesync, whose repair wipes the active
  // outline and detaches the editor mid-keystroke.
  //
  // The REASON this passes changed in pkm-s7af: not "this message is on a
  // retention allowlist" but "the replica did not report a rejection of the
  // op". Note that this failure happens on a SUCCESSFULLY OPEN database, so it
  // is not an availability failure at all — which is why the rule cannot be a
  // check on the availability type.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = laneOnlyReplica();
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  expect(desyncs).toEqual([]);
  const body = bodies[0].body as { client_id: string; ops: unknown[] };
  expect(body.ops).toEqual([op("u1")]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("a replica that REJECTS the op desyncs and is not retained", async () => {
  // Characterisation for pkm-s7af: an unsupported title syntax is the replica
  // refusing the op on its merits (replica/queue.ts throws LocalOpError), and
  // the server would refuse it too — so retaining and retrying it can never
  // help. Task 4 inverted the retain rule from a message allowlist to "retain
  // everything except this"; this is the "except". The `rejected` flag is no
  // longer inert: opQueue.ts reads `replicaError?.rejected === true` as the
  // sole discriminator for the only onDesync path a replica failure can
  // reach, so this is now a test of the flag itself, not just of the
  // message.
  const replica = memReplica({
    enqueue: async () => { throw new ReplicaError(
      'unsupported reference title syntax: "a[[b]]"', { rejected: true }); },
  });
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = q.enqueue([
    { op: "update_text", uid: "u1", text: "a[[b]]" },
  ]);

  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
  expect(desyncs).toHaveLength(1);
  // Not retained: nothing is left pending to deliver.
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
});

test("an unclassified replica enqueue failure is retained, not desynced", async () => {
  // This test used to pin the opposite (`desyncs.length` 1). Retention was an
  // allowlist of three error shapes, so an error carrying no flags at all fell
  // through to onDesync; under the one-item blocklist it is retained, because a
  // plain error is not the replica reporting that it refused the OP. Only that
  // one report means the server would refuse it too — everything else means
  // "could not persist locally", which is never grounds for wiping the active
  // outline to server state (pkm-9x6u).
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica({
    enqueue: async () => { throw new Error("worker crashed"); },
  });
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  await q.drain();
  expect(desyncs).toEqual([]);
  expect((bodies[0].body as { ops: unknown[] }).ops).toEqual([op("u1")]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("a terminal RPC failure retains the op instead of desyncing", async () => {
  // pkm-9x6u's second half: a dead worker or a module chunk 404 after a deploy
  // makes every call reject with RpcLifecycleError, which no availability
  // *mode* would ever see because SyncProvider only reports "no-replica" for
  // availabilityOf(error) === "unusable", never reached here.
  fetchSeq([() => jsonResponse({ ok: true })]);
  const desyncs: unknown[] = [];
  const replica = memReplica();
  replica.enqueue = () => Promise.reject(
    new RpcLifecycleError("worker-error", "replica worker failed"));
  replica.nextBatch = () => Promise.reject(
    new RpcLifecycleError("worker-error", "replica worker failed"));
  const queue = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = queue.enqueue([{ op: "delete", uid: "u1" }]);
  await ticket.settled;
  expect(desyncs).toEqual([]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("an RPC timeout retains the op but does not latch the replica off", async () => {
  // A timeout rejects one request and leaves the RPC client usable, so it must
  // not be mistaken for a dead replica: the next drain still asks.
  fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  let enqueues = 0;
  replica.enqueue = () => {
    enqueues += 1;
    return Promise.reject(new RpcLifecycleError("timeout", "replica RPC enqueue timed out"));
  };
  let nextBatchCalls = 0;
  replica.nextBatch = () => { nextBatchCalls += 1; return Promise.resolve(null); };
  const queue = createOpQueue(replica, () => undefined);
  await queue.enqueue([{ op: "delete", uid: "u1" }]).delivered;
  await queue.drain();
  expect(enqueues).toBe(1);
  expect(nextBatchCalls).toBeGreaterThan(0);
});

test("a lost-reply enqueue retains the lane copy under the durable row's batch id", async () => {
  // The worker persisted the row but the reply never arrived (e.g. iOS
  // suspending the PWA mid-RPC, pkm-ybgt). Both copies may deliver; they must
  // carry ONE batch id so the second POST hits the server's applied_batches
  // replay (stored ack) instead of a create-collision 400.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const persist = replica.enqueue.bind(replica);
  replica.enqueue = async (ops, batchId) => {
    void await persist(ops, batchId);
    throw new RpcLifecycleError("timeout", "replica RPC enqueue timed out");
  };
  const q = createOpQueue(replica, () => undefined);
  await q.enqueue([op("u1")]).delivered;
  await q.drain();
  const ids = bodies.map((b) => (b.body as { batch_id: string }).batch_id);
  expect(ids).toHaveLength(2); // durable row first, then the retained copy
  expect(ids[1]).toBe(ids[0]);
});

test("a dead replica is asked once, then never again", async () => {
  const replica = memReplica();
  let nextBatchCalls = 0;
  replica.nextBatch = () => {
    nextBatchCalls += 1;
    return Promise.reject(new ReplicaUnavailableError("no openable database"));
  };
  const queue = createOpQueue(replica, () => undefined);
  await expect(queue.drain()).resolves.toEqual({ status: "drained" });
  await expect(queue.drain()).resolves.toEqual({ status: "drained" });
  expect(nextBatchCalls).toBe(1);
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

test("dispose during replica persistence settles delivery exactly once", async () => {
  const persisted = deferred<{ pending: number; batchId: string }>();
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
    event: expect.objectContaining({ rowId: 1, batchId: replica.enqueued[0] }),
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
      return {
        pending: replica.rows.filter((row) => !row.poisoned).length,
        matched: true,
      };
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
    event: expect.objectContaining({ rowId: 1, batchId: replica.enqueued[0] }),
    error,
  }]);
  expect(poisons).toEqual([]);
  expect(markAttempts).toBe(1);
  expect(bodies).toHaveLength(1);

  await recovery.retryPoisonMarks?.();

  expect(markAttempts).toBe(2);
  expect(poisons).toEqual([
    expect.objectContaining({ rowId: 1, batchId: replica.enqueued[0] }),
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
      return {
        pending: replica.rows.filter((row) => !row.poisoned).length,
        matched: true,
      };
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
    expect.objectContaining({ rowId: 1, batchId: replica.enqueued[0] }),
  ]);

  await recovery.retryPoisonMarks?.();

  expect(markAttempts).toBe(2);
  expect(bodies).toHaveLength(1);
  expect(poisons).toEqual([
    expect.objectContaining({ rowId: 1, batchId: replica.enqueued[0] }),
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
    return {
      pending: replica.rows.filter((row) => !row.poisoned).length,
      matched: true,
    };
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
  const mark = vi.fn(async () => ({ pending: 0, matched: true }));
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
  const mark = vi.fn(async (id: number, _error: string, batchId: string) => {
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

test("discarding retained mark intents clears them without touching the replica",
async () => {
  // pkm-tu5k: the escape from a permanently-wedged profile. Discard must not
  // require an openable replica — that impossibility is the whole scenario.
  const wedged: PoisonEvent = {
    rowId: 1, batchId: "bad-batch", ops: [op("bad")], status: 400,
    message: "request failed: 400 /api/ops",
  };
  localStorage.setItem("pkm.poison-mark-intents.v1", JSON.stringify({
    version: 1, intents: [wedged],
  }));
  const replica = memReplica();
  const mark = vi.fn(async () => { throw new Error("unopenable"); });
  (replica as unknown as { markPoisoned: typeof mark }).markPoisoned = mark;
  const q = createOpQueue(replica, () => undefined);

  q.discardPoisonIntents();

  expect(q.poisonMarkIntents()).toEqual([]);
  expect(localStorage.getItem("pkm.poison-mark-intents.v1")).toBeNull();
  await expect(q.retryPoisonMarks()).resolves.toEqual([]);
  expect(mark).not.toHaveBeenCalled();
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

// --- pkm-49eh: an enqueue that cannot persist locally joins an ordered
// in-memory lane instead of being POSTed directly from enqueue(). ---

test("an unpersistable enqueue is retained offline and delivered on reconnect",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = laneOnlyReplica();
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  q.setOnline(false);

  const ticket = q.enqueue([op("u1")]);
  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  await q.settled();
  // offline: no direct post, and the op is retained rather than dropped
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 1,
  });
  expect(bodies).toEqual([]);
  expect(desyncs).toEqual([]);

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect((bodies[0].body as { ops: unknown[] }).ops).toEqual([op("u1")]);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("a retained op stays behind the durable batches that preceded it",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  q.enqueue([op("first")]);          // durable row batch-1
  await q.settled();
  replica.enqueue = async () => { throw new Error(CANTOPEN); };
  const second = q.enqueue([op("second")]); // retained in memory
  await q.settled();
  // settle the offline drain before reconnecting: drain() hands a caller any
  // run already in flight, so a shared blocked run would mask the reconnect
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 2,
  });

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops))
    .toEqual([[op("first")], [op("second")]]);
  await expect(second.delivered).resolves.toEqual({ status: "delivered" });
});

test("a durable batch persisted after a retained op cannot overtake it",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const durableEnqueue = replica.enqueue.bind(replica);
  replica.enqueue = async () => { throw new Error(CANTOPEN); };
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  const retained = q.enqueue([op("older")]);
  await q.settled();
  replica.enqueue = durableEnqueue;      // local storage recovers
  q.enqueue([op("newer")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 2,
  });

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops))
    .toEqual([[op("older")], [op("newer")]]);
  await expect(retained.delivered).resolves.toEqual({ status: "delivered" });
});

test("a retained op queued behind one durable batch keeps its place between them",
async () => {
  // The three-way interleave: only the count of durable batches persisted
  // *since* the previous retained entry keeps the second entry behind the
  // durable row while still ahead of nothing else.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const durableEnqueue = replica.enqueue.bind(replica);
  const failEnqueue = async (): Promise<never> => {
    throw new Error(CANTOPEN);
  };
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  replica.enqueue = failEnqueue;
  const first = q.enqueue([op("retained-1")]);
  await q.settled();
  replica.enqueue = durableEnqueue;
  q.enqueue([op("durable")]);
  await q.settled();
  replica.enqueue = failEnqueue;
  const second = q.enqueue([op("retained-2")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 3,
  });

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops))
    .toEqual([[op("retained-1")], [op("durable")], [op("retained-2")]]);
  await expect(first.delivered).resolves.toEqual({ status: "delivered" });
  await expect(second.delivered).resolves.toEqual({ status: "delivered" });
});

test("a poisoned durable batch stops standing ahead of a retained op",
async () => {
  // A 4xx poisons the durable row and the recovery coordinator deletes it
  // outside the queue, so no deleteBatch ever arrives to decrement the lane.
  // The poison itself must, or once the repair resumes a batch enqueued
  // *after* the retained op would be posted ahead of it.
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const replica = memReplica();
  const durableEnqueue = replica.enqueue.bind(replica);
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  q.enqueue([op("rejected")]);              // durable row, drains first
  await q.settled();
  replica.enqueue = async () => { throw new Error(CANTOPEN); };
  const retained = q.enqueue([op("retained")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 2,
  });

  q.setOnline(true);
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering",
  });

  // the repair deletes the poisoned row, and newer work is enqueued before
  // delivery resumes
  replica.rows.length = 0;
  replica.enqueue = durableEnqueue;
  q.enqueue([op("newer")]);
  await q.settled();
  q.resume("recovery");

  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops)).toEqual([
    [op("rejected")], [op("retained")], [op("newer")],
  ]);
  await expect(retained.delivered).resolves.toEqual({ status: "delivered" });
});

test("a successful out-of-band flush settles an orphaned durable ticket",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  const flushed = q.enqueue([op("flushed")]);
  const remaining = q.enqueue([op("remaining")]);
  await q.settled();
  replica.rows.splice(0, 1); // a successfully POSTed recovery/reset flush

  let flushedOutcome: unknown;
  void flushed.delivered.then((outcome) => { flushedOutcome = outcome; });
  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  await expect(remaining.delivered).resolves.toEqual({ status: "delivered" });
  await Promise.resolve();

  expect(bodies.map((entry) => (entry.body as { ops: unknown[] }).ops))
    .toEqual([[op("remaining")]]);
  expect(flushedOutcome).toEqual({ status: "delivered" });
});

test("a rebase-flushed durable queue leaves no phantom ahead of a later retained op",
async () => {
  // A rebase flushes the durable queue behind the queue's back, so the batches
  // counted ahead of a retained entry simply vanish. Observing an empty
  // durable queue clears those counts — including the running count of batches
  // persisted since the last entry, or the *next* entry appended would inherit
  // a phantom and let a newer durable batch overtake it.
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "busy" }, 503),
    () => jsonResponse({ ok: true }),
  ]);
  const replica = memReplica();
  const durableEnqueue = replica.enqueue.bind(replica);
  const failEnqueue = async (): Promise<never> => {
    throw new Error(CANTOPEN);
  };
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  q.enqueue([op("durable-1")]);
  await q.settled();
  replica.enqueue = failEnqueue;
  const first = q.enqueue([op("retained-1")]);  // one durable batch ahead
  await q.settled();
  replica.enqueue = durableEnqueue;
  q.enqueue([op("durable-2")]);                 // counted behind retained-1
  await q.settled();
  replica.rows.length = 0;                      // the rebase flush

  // the drain observes the empty durable queue, then fails to deliver the
  // retained entry, so the lane is still occupied afterwards
  q.setOnline(true);
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "retryable", pending: 1,
  });
  q.setOnline(false);                           // no kicks while we set up

  replica.enqueue = failEnqueue;
  const second = q.enqueue([op("retained-2")]);
  await q.settled();
  replica.enqueue = durableEnqueue;
  q.enqueue([op("durable-3")]);                 // newer than retained-2
  await q.settled();
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "offline", pending: 3,
  });

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops)).toEqual([
    [op("retained-1")],   // the 503
    [op("retained-1")],
    [op("retained-2")],
    [op("durable-3")],
  ]);
  await expect(first.delivered).resolves.toEqual({ status: "delivered" });
  await expect(second.delivered).resolves.toEqual({ status: "delivered" });
});

test("a 5xx keeps the retained op under the same batch id and the backoff retry delivers it",
async () => {
  vi.useFakeTimers();
  try {
    const { bodies } = fetchSeq([
      () => jsonResponse({ detail: "busy" }, 503),
      () => jsonResponse({ ok: true }),
    ]);
    const replica = laneOnlyReplica();
    const q = createOpQueue(replica, () => undefined);
    const ticket = q.enqueue([op("u1")]);
    await q.settled();

    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "retryable", pending: 1,
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });
    await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
    // one id for both attempts: the server binds batch_id to sha256(ops)
    const ids = bodies.map((b) => (b.body as { batch_id: string }).batch_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  } finally {
    vi.useRealTimers();
  }
});

test("a transport failure on a retained op keeps it for the next drain", async () => {
  // Not an ApiError at all (fetch itself rejects): retryable like a 5xx, and
  // the op must survive to be posted again rather than being discarded.
  let calls = 0;
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: RequestInfo | URL,
                                      init?: RequestInit) => {
    calls += 1;
    bodies.push(JSON.parse(String(init?.body)));
    if (calls === 1) throw new TypeError("network down");
    return jsonResponse({ ok: true });
  }));
  const replica = laneOnlyReplica();
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const ticket = q.enqueue([op("u1")]);
  await q.settled();

  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "retryable", pending: 1,
  });
  expect(desyncs).toEqual([]);
  q.setOnline(false);
  q.setOnline(true); // reconnect kick, as after a real network drop
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
  expect(bodies).toHaveLength(2);
});

test("a 4xx discards only the rejected retained op and holds the rest behind repair",
async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const replica = laneOnlyReplica();
  const desyncs: unknown[] = [];
  const q = createOpQueue(replica, (e) => desyncs.push(e));
  const bad = q.enqueue([op("bad")]);
  const good = q.enqueue([op("good")]);
  await q.settled();

  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 1,
  });
  await expect(bad.delivered).resolves.toMatchObject({ status: "failed" });
  expect(desyncs).toHaveLength(1);
  expect(bodies).toHaveLength(1); // the good op waits for the repair

  q.resume("recovery");
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  await expect(good.delivered).resolves.toEqual({ status: "delivered" });
});

test("a retained op still delivers when the durable count it queued behind was stale",
async () => {
  // countPending() can read a backlog a concurrent drain is already clearing.
  // An over-count only delays the entry, and the clamp on an observed-empty
  // durable queue is what guarantees it still goes out.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = laneOnlyReplica({
    pendingCount: async () => 3,   // no rows exist, but the count claims three
  });
  const q = createOpQueue(replica, () => undefined);
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies).toHaveLength(1);
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("going offline mid-drain holds the rest of the lane at the barrier",
async () => {
  // Between retained entries the lane re-checks connectivity exactly like the
  // durable pump: one delivered entry must not license posting the next.
  const replica = laneOnlyReplica();
  const q = createOpQueue(replica, () => undefined);
  const { bodies } = fetchSeq([() => {
    q.setOnline(false); // the socket drops while the first POST is in flight
    return jsonResponse({ ok: true });
  }, () => jsonResponse({ ok: true })]);
  const first = q.enqueue([op("first")]);
  const second = q.enqueue([op("second")]);
  await q.settled();

  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 1,
  });
  await expect(first.delivered).resolves.toEqual({ status: "delivered" });
  expect(bodies).toHaveLength(1);

  q.setOnline(true);
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  await expect(second.delivered).resolves.toEqual({ status: "delivered" });
});

test("an enqueue that has not started when dispose lands never reaches the replica",
async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  const enqueue = vi.fn(async () => { throw new Error(CANTOPEN); });
  const q = createOpQueue(laneOnlyReplica({ enqueue }), () => undefined);
  const ticket = q.enqueue([op("u1")]);
  q.dispose();          // before the persist chain's microtask even runs

  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
  expect(enqueue).not.toHaveBeenCalled();
});

test("an enqueue that fails after dispose settles instead of hanging", async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const replica = laneOnlyReplica({
    enqueue: async () => { entered(); await gate; throw new Error(CANTOPEN); },
  });
  const q = createOpQueue(replica, () => undefined);
  const ticket = q.enqueue([op("u1")]);
  await started;        // the write is genuinely in flight inside the replica
  q.dispose();          // teardown races a write that is already in flight
  release();
  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  // retaining it would leave `delivered` pending forever: dispose has already
  // run, so nothing else would ever settle this entry
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
});

test("dispose while a retained op reads the durable count still settles it",
async () => {
  // countPending() is a worker RPC, so dispose() can land after its settle
  // loop has already run: an entry appended in that window would leave
  // `delivered` pending forever, and every holder of that promise leaking.
  fetchSeq([() => jsonResponse({ ok: true })]);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const counting = new Promise<void>((r) => { entered = r; });
  const replica = laneOnlyReplica({
    pendingCount: async () => { entered(); await gate; return 0; },
  });
  const q = createOpQueue(replica, () => undefined);
  const ticket = q.enqueue([op("u1")]);
  await counting;       // the enqueue is parked inside countPending()
  q.dispose();
  release();

  await expect(ticket.settled).resolves.toMatchObject({ status: "failed" });
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "disposed", pending: 0,
  });
});

test("retained ops count as pending and are failed exactly once by dispose",
async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = laneOnlyReplica();
  const q = createOpQueue(replica, () => undefined);
  const counts: number[] = [];
  q.onPending((n) => counts.push(n));
  q.setOnline(false);
  const ticket = q.enqueue([op("u1")]);
  await q.settled();
  expect(counts.at(-1)).toBe(1); // the header must not report 0 pending

  let outcomes = 0;
  void ticket.delivered.then(() => { outcomes += 1; });
  q.dispose();
  await expect(ticket.delivered).resolves.toMatchObject({ status: "failed" });
  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "disposed", pending: 1,
  });
  expect(outcomes).toBe(1);
});

test("a reconnect landing on a blocked drain redrains without a further kick",
async () => {
  // pkm-v5x5: setOnline(true) can arrive while a drain is already concluding
  // "offline". Its kick is only recorded on the in-flight run, so dropping it
  // would leave the batch waiting for whatever kicks the queue next — the
  // user's next edit, or another reconnect.
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const held = deferred<void>();
  let counts = 0;
  const replica = memReplica();
  replica.pendingCount = async () => {
    counts += 1;
    // hold the offline drain inside the report it is already committed to
    if (counts === 1) await held.promise;
    return replica.rows.filter((row) => !row.poisoned).length;
  };
  const drains: string[] = [];
  const q = createOpQueue(replica, () => undefined,
                          (outcome) => drains.push(outcome.status));
  q.setOnline(false);

  const ticket = q.enqueue([op("u1")]); // its own kick starts the offline drain
  await vi.waitFor(() => { expect(counts).toBe(1); });
  expect(bodies).toEqual([]);

  q.setOnline(true); // the reconnect races that drain's blocked conclusion
  held.resolve();

  await vi.waitFor(() => { expect(bodies).toHaveLength(1); });
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
  expect(drains).toEqual(["blocked", "drained"]);
});

test("a failed poison mark cannot decrement the lane twice for one batch",
async () => {
  // pkm-yavj: the lane is decremented before the mark RPC, so a mark that
  // throws leaves the row deliverable and an outside resume hands the same
  // batch out again. Counting it twice would drop the head's count below the
  // batches genuinely ahead of it, letting the retained op overtake one.
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  let markAttempts = 0;
  const replica = memReplica();
  const durableEnqueue = replica.enqueue.bind(replica);
  replica.markPoisoned = async (id) => {
    markAttempts += 1;
    if (markAttempts === 1) throw new Error("worker disappeared");
    replica.rows.find((row) => row.id === id)!.poisoned = true;
    return {
      pending: replica.rows.filter((row) => !row.poisoned).length,
      matched: true,
    };
  };
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);

  q.enqueue([op("rejected")]);  // row 1: rejected, and its mark fails
  q.enqueue([op("durable")]);   // row 2: still genuinely ahead of the lane
  await q.settled();
  replica.enqueue = async () => { throw new Error(CANTOPEN); };
  const retained = q.enqueue([op("retained")]);  // two durable batches ahead
  await q.settled();
  replica.enqueue = durableEnqueue;

  q.setOnline(true);
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering",
  });
  expect(markAttempts).toBe(1); // the mark threw: row 1 is still deliverable

  // an outside resume (SyncProvider's legacy repair, replicaSync) lifts the
  // barrier, and nextBatch hands the unmarked row out for a second rejection
  q.resume("recovery");
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering",
  });

  q.resume("recovery");
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect(bodies.map((b) => (b.body as { ops: unknown[] }).ops)).toEqual([
    [op("rejected")], [op("rejected")], [op("durable")], [op("retained")],
  ]);
  await expect(retained.delivered).resolves.toEqual({ status: "delivered" });
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

// --- pkm-0htf: onUnsentInMemory reports only the fallback lane (ops that
// exist ONLY in this tab's memory), never durable rows that survive a
// reload, so a beforeunload guard gated on it never fires for ordinary
// offline reloads. ---

test("a persist failure retained in the lane emits 1 on onUnsentInMemory; delivering it returns to 0",
async () => {
  const { bodies } = fetchSeq([() => jsonResponse({ ok: true })]);
  const replica = laneOnlyReplica();
  const q = createOpQueue(replica, () => undefined);
  const unsentCounts: number[] = [];
  q.onUnsentInMemory((n) => unsentCounts.push(n));
  q.enqueue([op("u1")]);
  await q.settled();
  expect(unsentCounts.at(-1)).toBe(1);

  await q.drain();
  expect(unsentCounts.at(-1)).toBe(0);
  expect(bodies).toHaveLength(1);
});

test("a count that did not move is not re-emitted (pkm-qfee)", async () => {
  fetchSeq([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(memReplica(), () => undefined);
  const pendingCounts: number[] = [];
  const unsentCounts: number[] = [];
  q.onPending((n) => pendingCounts.push(n));
  q.onUnsentInMemory((n) => unsentCounts.push(n));
  for (const uid of ["u1", "u2"]) {
    q.enqueue([op(uid)]);
    await q.settled();
    await q.drain();
  }
  // Both edits move the durable count, so both are published...
  expect(pendingCounts).toEqual([1, 0, 1, 0]);
  // ...but the empty in-memory lane is published once and then left alone:
  // every emit is a new context identity for each mounted outline (pkm-qfee).
  expect(unsentCounts).toEqual([0]);
});

test("a healthy durable enqueue reports non-zero onPending while onUnsentInMemory stays 0",
async () => {
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  const pendingCounts: number[] = [];
  const unsentCounts: number[] = [];
  q.onPending((n) => pendingCounts.push(n));
  q.onUnsentInMemory((n) => unsentCounts.push(n));
  q.setOnline(false); // durable row persists but is not yet delivered
  q.enqueue([op("u1")]);
  await q.settled();
  expect(pendingCounts.at(-1)).toBe(1);
  expect(unsentCounts.at(-1)).toBe(0); // a durable row is not in-memory-only
});

// --- Connectivity, barrier and backoff policy (pkm-w5gf). These rules used to
// be pinned only against the in-memory queue that ran when no Replica existed;
// they are the queue's policy, not that implementation's, so they are pinned
// here against the one queue that ships. onDesync is reached from a lane 4xx:
// a durable row's rejection takes the poison path instead. ---

test("ops re-enqueued synchronously from onDesync are not stranded", async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  let q!: ReturnType<typeof createOpQueue>;
  q = createOpQueue(laneOnlyReplica(), () => {
    q.enqueue([op("u9")]);
    q.resume("recovery");
  });
  const rejected = q.enqueue([op("u1")]);
  await q.settled();
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering",
  });
  await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
  await vi.waitFor(() => { expect(bodies).toHaveLength(2); });
  expect((bodies[1].body as { ops: unknown[] }).ops).toEqual([op("u9")]);
  q.dispose();
});

test("an async recovery resume hands a missed kick to the next drain owner",
async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  let q!: ReturnType<typeof createOpQueue>;
  q = createOpQueue(laneOnlyReplica(), () => {
    void Promise.resolve().then(() => q.resume("recovery"));
  });
  q.setOnline(false);
  const rejected = q.enqueue([op("rejected")]);
  const later = q.enqueue([op("later")]);
  await q.settled();

  try {
    q.setOnline(true);
    await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
    // nobody drains again from the outside: the resume's own kick must deliver
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
    expect((bodies[1].body as { ops: unknown[] }).ops).toEqual([op("later")]);
  } finally {
    q.dispose();
  }
});

test("a throwing onDesync does not poison the queue or drain()", async () => {
  const { bodies } = fetchSeq([
    () => jsonResponse({ detail: "bad op" }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const q = createOpQueue(laneOnlyReplica(), () => {
    throw new Error("desync handler exploded");
  });
  q.enqueue([op("u1")]);
  await q.settled();
  // must resolve, not reject: the drain owner is not the repair owner
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering",
  });

  q.resume("recovery");
  const later = q.enqueue([op("u2")]);
  await q.settled();
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  expect(bodies).toHaveLength(2);
});

/** A fetch whose first POST parks until released, so a test can act while one
 * batch is genuinely in flight. `started` resolves once that POST is entered. */
function gatedFetch(firstResponse: () => Response) {
  const started = deferred<void>();
  const release = deferred<void>();
  const sequence = fetchSeq([
    async () => {
      started.resolve();
      await release.promise;
      return firstResponse();
    },
    () => jsonResponse({ ok: true }),
  ]);
  return {
    ...sequence,
    started: started.promise,
    release: () => release.resolve(),
  };
}

test("an in-flight POST completes after going offline without starting a new pump",
async () => {
  const { bodies, started, release } =
    gatedFetch(() => jsonResponse({ ok: true }));
  const replica = memReplica();
  const q = createOpQueue(replica, () => undefined);
  q.setOnline(false);
  const first = q.enqueue([op("u1")]);
  await q.settled();
  q.setOnline(true);       // connected: the pump starts, POST for u1 in flight
  await started;
  q.setOnline(false);      // socket drops while the POST is outstanding
  q.enqueue([op("u2")]);   // persisted while offline -> must stay pending
  await q.settled();
  release();               // the in-flight POST's response arrives

  await expect(q.drain()).resolves.toEqual({
    status: "blocked", reason: "offline", pending: 1,
  });
  await expect(first.delivered).resolves.toEqual({ status: "delivered" });
  expect(bodies).toHaveLength(1); // u2 did NOT start a new pump

  q.setOnline(true);       // reconnect flushes the preserved batch
  await expect(q.drain()).resolves.toEqual({ status: "drained" });
  expect((bodies[1].body as { ops: unknown[] }).ops).toEqual([op("u2")]);
});

test("a missed in-flight kick remains barred by recovery until explicit resume",
async () => {
  const { bodies, started, release } =
    gatedFetch(() => jsonResponse({ ok: true }));
  const q = createOpQueue(memReplica(), () => undefined);
  q.setOnline(false);
  const first = q.enqueue([op("u1")]);
  await q.settled();
  q.setOnline(true);
  await started;
  const later = q.enqueue([op("u2")]); // its kick is recorded on the live run
  await q.settled();
  q.pause("recovery");

  release();
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 1,
  });
  await expect(first.delivered).resolves.toEqual({ status: "delivered" });
  expect(bodies).toHaveLength(1);

  q.resume("recovery");
  await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  expect(bodies).toHaveLength(2);
});

test("dispose drops a missed in-flight kick without another POST", async () => {
  const { bodies, started, release } =
    gatedFetch(() => jsonResponse({ ok: true }));
  const q = createOpQueue(memReplica(), () => undefined);
  q.setOnline(false);
  q.enqueue([op("u1")]);
  await q.settled();
  q.setOnline(true);
  await started;
  const later = q.enqueue([op("u2")]);
  await q.settled();
  q.dispose();

  release();
  await expect(later.delivered).resolves.toMatchObject({ status: "failed" });
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "disposed",
  });
  expect(bodies).toHaveLength(1);
});

test("a missed in-flight kick does not bypass the scheduled 5xx backoff",
async () => {
  vi.useFakeTimers();
  try {
    const { bodies, started, release } =
      gatedFetch(() => jsonResponse({ detail: "busy" }, 503));
    const q = createOpQueue(memReplica(), () => undefined);
    q.setOnline(false);
    q.enqueue([op("u1")]);
    await q.settled();
    q.setOnline(true);
    await started;
    const later = q.enqueue([op("u2")]);
    await q.settled();     // kick recorded while the failing POST is in flight

    release();
    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "retryable", pending: 2,
    });
    expect(bodies).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(bodies).toHaveLength(1); // the kick waited for the armed retry
    await vi.advanceTimersByTimeAsync(1);
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
    expect(bodies).toHaveLength(3); // the retry resends u1, then u2 follows
  } finally {
    vi.useRealTimers();
  }
});

test("reconnect resets the retry delay to 250ms", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return jsonResponse({ detail: "busy" }, 503);
    }));
    const q = createOpQueue(memReplica(), () => undefined);
    await q.enqueue([op("u1")]).settled;
    await expect(q.drain()).resolves.toMatchObject({ reason: "retryable" });
    await vi.advanceTimersByTimeAsync(250); // second failure schedules 1s
    expect(calls).toBe(2);

    q.setOnline(false);
    q.setOnline(true); // immediate failure; reconnect resets the backoff
    await expect(q.drain()).resolves.toMatchObject({ reason: "retryable" });
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(4);
    q.dispose();
  } finally {
    vi.useRealTimers();
  }
});
