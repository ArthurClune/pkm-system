import { expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import { jsonResponse } from "../test-helpers";
import { clientId, createOpQueue } from "./opQueue";

const op = (uid: string): BlockOp => ({ op: "delete", uid });

function capturingFetch(responses: Array<() => Response>) {
  const bodies: unknown[] = [];
  let call = 0;
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const make = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return make();
  });
  vi.stubGlobal("fetch", mock);
  return { bodies, mock };
}

test("clientId is stable and uid-shaped", () => {
  expect(clientId).toMatch(/^[a-zA-Z0-9_-]{6,32}$/);
});

test("ops enqueued in the same tick coalesce into one batch", async () => {
  const { bodies, mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(null, () => undefined);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2"), op("u3")]);
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(1);
  const body = bodies[0] as { client_id: string; batch_id?: string; ops: unknown[] };
  expect(body.client_id).toBe(clientId);
  expect(body.batch_id).toBeDefined();
  expect(body.ops).toEqual([op("u1"), op("u2"), op("u3")]);
});

test("ops enqueued while a batch is in flight go in the next batch", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const bodies: unknown[] = [];
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) await gate;
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  const q = createOpQueue(null, () => undefined);
  q.enqueue([op("u1")]);
  await Promise.resolve(); // let the first batch dispatch
  q.enqueue([op("u2")]);
  release();
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u2")]);
});

test("a failed batch reports desync; queue works after repair releases it", async () => {
  const { mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const onDesync = vi.fn();
  const q = createOpQueue(null, onDesync);
  q.enqueue([op("u1"), op("u2")]);
  await q.drain();
  expect(onDesync).toHaveBeenCalledTimes(1);
  // The repair owner explicitly releases later delivery.
  q.resume("recovery");
  q.enqueue([op("u3")]);
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(2);
});

test("ops re-enqueued synchronously from onDesync are not stranded", async () => {
  const { bodies, mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const q = createOpQueue(null, () => {
    q.enqueue([op("u9")]);
    q.resume("recovery");
  });
  q.enqueue([op("u1")]);
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u9")]);
});

test("an async recovery resume hands a missed kick to the next drain owner", async () => {
  const { bodies, mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  let q!: ReturnType<typeof createOpQueue>;
  q = createOpQueue(null, () => {
    void Promise.resolve().then(() => q.resume("recovery"));
  });
  q.setOnline(false);
  const rejected = q.enqueue(
    Array.from({ length: 500 }, (_, i) => op(`rejected-${i}`)),
  );
  const later = q.enqueue([op("later")]);

  try {
    q.setOnline(true);
    await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(2));
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
    expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("later")]);
  } finally {
    q.dispose();
  }
});

test("a throwing onDesync does not poison the queue or drain()", async () => {
  const { mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const q = createOpQueue(null, () => {
    throw new Error("desync handler exploded");
  });
  q.enqueue([op("u1")]);
  await q.drain(); // must resolve, not reject
  q.resume("recovery");
  // queue survives after the repair owner releases the barrier
  q.enqueue([op("u2")]);
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(2);
});

test("while offline, enqueue is preserved but pumps no HTTP", async () => {
  const { mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(null, () => undefined);
  q.setOnline(false);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2")]);
  await q.drain();
  await Promise.resolve(); // give any stray microtask a chance to POST
  expect(mock).not.toHaveBeenCalled();
});

test("reconnect flushes the ops preserved while offline, in order", async () => {
  const { bodies, mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(null, () => undefined);
  q.setOnline(false);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2")]);
  q.setOnline(true);
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(1);
  expect((bodies[0] as { ops: unknown[] }).ops).toEqual([op("u1"), op("u2")]);
});

test("an in-flight POST completes after going offline without starting a new pump", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const bodies: unknown[] = [];
  const mock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) await gate;
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  const q = createOpQueue(null, () => undefined);
  q.enqueue([op("u1")]);   // connected: pump starts, POST for u1 in flight
  await Promise.resolve(); // let that batch dispatch
  q.setOnline(false);      // socket drops while the POST is outstanding
  q.enqueue([op("u2")]);   // enqueued while offline -> must stay pending
  release();               // the in-flight POST's response arrives
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(1); // u2 did NOT start a new pump
  q.setOnline(true);       // reconnect flushes the preserved op
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u2")]);
});

test("a missed in-flight kick remains barred by recovery until explicit resume", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const mock = vi.fn(async () => {
    if (mock.mock.calls.length === 1) await gate;
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  const q = createOpQueue(null, () => undefined);
  const first = q.enqueue([op("u1")]);
  await Promise.resolve();
  const later = q.enqueue([op("u2")]);
  q.pause("recovery");

  release();
  await expect(first.delivered).resolves.toEqual({ status: "delivered" });
  await Promise.resolve();
  expect(mock).toHaveBeenCalledTimes(1);
  q.resume("recovery");
  await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  expect(mock).toHaveBeenCalledTimes(2);
});

test("dispose drops a missed in-flight kick without another POST", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const mock = vi.fn(async () => {
    await gate;
    return jsonResponse({ ok: true });
  });
  vi.stubGlobal("fetch", mock);
  const q = createOpQueue(null, () => undefined);
  q.enqueue([op("u1")]);
  await Promise.resolve();
  const later = q.enqueue([op("u2")]);
  q.dispose();

  release();
  await expect(later.delivered).resolves.toMatchObject({ status: "failed" });
  await Promise.resolve();
  expect(mock).toHaveBeenCalledTimes(1);
});

test("batches larger than 500 ops split into sequential POSTs", async () => {
  const { bodies, mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(null, () => undefined);
  const ops = Array.from({ length: 501 }, (_, i) => op(`u${i}`));
  q.enqueue(ops);
  await q.drain();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[0] as { ops: unknown[] }).ops).toHaveLength(500);
  expect((bodies[1] as { ops: unknown[] }).ops).toHaveLength(1);
});

test("legacy offline enqueue settles in memory while drain reports blocked", async () => {
  const { mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(null, () => undefined);
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

test("legacy write ticket reports delivery only after its ops POST succeeds", async () => {
  let release!: () => void;
  const posted = new Promise<void>((done) => { release = done; });
  vi.stubGlobal("fetch", vi.fn(async () => {
    await posted;
    return jsonResponse({ ok: true });
  }));
  const q = createOpQueue(null, () => undefined);

  const ticket = q.enqueue([op("u1")], ["page", "Page"]);
  await ticket.settled;
  let delivered = false;
  void ticket.delivered.then(() => { delivered = true; });
  await Promise.resolve();
  expect(delivered).toBe(false);

  release();
  await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
});

test("legacy 4xx fails only tickets touched by the rejected batch and barriers later work", async () => {
  const { bodies, mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const onDesync = vi.fn();
  const q = createOpQueue(null, onDesync);
  q.setOnline(false);
  const first = q.enqueue(
    Array.from({ length: 300 }, (_, i) => op(`first-${i}`)),
  );
  const spanning = q.enqueue(
    Array.from({ length: 250 }, (_, i) => op(`spanning-${i}`)),
  );
  const later = q.enqueue([op("later-1"), op("later-2")]);
  let laterDelivery: unknown;
  void later.delivered.then((outcome) => { laterDelivery = outcome; });

  q.setOnline(true);
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 2,
  });

  expect(mock).toHaveBeenCalledTimes(1);
  expect((bodies[0] as { ops: unknown[] }).ops).toHaveLength(500);
  await expect(first.delivered).resolves.toMatchObject({ status: "failed" });
  await expect(spanning.delivered).resolves.toMatchObject({ status: "failed" });
  expect(laterDelivery).toBeUndefined();
  await expect(q.drain()).resolves.toMatchObject({
    status: "blocked", reason: "recovering", pending: 2,
  });
  expect(mock).toHaveBeenCalledTimes(1);

  q.resume("recovery");
  await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([
    op("later-1"), op("later-2"),
  ]);
  expect(onDesync).toHaveBeenCalledTimes(1);
});

test("legacy 503 retains work and retries after 250ms", async () => {
  vi.useFakeTimers();
  try {
    const { mock } = capturingFetch([
      () => jsonResponse({ detail: "busy" }, 503),
      () => jsonResponse({ ok: true }),
    ]);
    const q = createOpQueue(null, () => undefined);
    await q.enqueue([op("u1")]).settled;

    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "retryable", pending: 1,
    });
    await vi.advanceTimersByTimeAsync(250);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });
    expect(mock).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

test("legacy queue sends a batch_id and freezes the slice across retries", async () => {
  vi.useFakeTimers();
  try {
    const { bodies, mock } = capturingFetch([
      () => jsonResponse({ detail: "busy" }, 500),
      () => jsonResponse({ ok: true }),
      () => jsonResponse({ ok: true }),
    ]);
    const q = createOpQueue(null, () => undefined);
    await q.enqueue([op("a")]).settled;

    await expect(q.drain()).resolves.toMatchObject({
      status: "blocked", reason: "retryable", pending: 1,
    });
    q.enqueue([op("b")]); // arrives during backoff; must NOT join the retry
    await vi.advanceTimersByTimeAsync(250);
    await expect(q.drain()).resolves.toEqual({ status: "drained" });

    expect(mock).toHaveBeenCalledTimes(3);
    const [first, second, third] = bodies as Array<
      { batch_id?: string; ops: unknown[] }
    >;
    expect(first.batch_id).toBeDefined();
    expect(second.batch_id).toBe(first.batch_id);
    expect(second.ops).toEqual(first.ops); // frozen: op "b" absent
    expect(third.batch_id).not.toBe(first.batch_id);
    expect(third.ops).toEqual([op("b")]);
  } finally {
    vi.useRealTimers();
  }
});

test("a missed in-flight kick does not bypass the scheduled 5xx backoff", async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return jsonResponse({ detail: "busy" }, 503);
      }
      return jsonResponse({ ok: true });
    }));
    const q = createOpQueue(null, () => undefined);
    q.enqueue([op("u1")]);
    await Promise.resolve();
    const later = q.enqueue([op("u2")]);

    release();
    await q.drain();
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
    // The frozen retry (call 2) resends only u1, byte-identical to call 1;
    // u2 -- enqueued after that slice was frozen -- gets its own call 3,
    // sent immediately once the retry succeeds (no further backoff).
    expect(calls).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});

test("legacy dispose cancels retry and keeps drain terminal", async () => {
  vi.useFakeTimers();
  try {
    const { mock } = capturingFetch([
      () => jsonResponse({ detail: "busy" }, 503),
    ]);
    const q = createOpQueue(null, () => undefined);
    await q.enqueue([op("u1")]).settled;
    await q.drain();

    q.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mock).toHaveBeenCalledTimes(1);
    await expect(q.drain()).resolves.toEqual({
      status: "blocked", reason: "disposed", pending: 1,
    });
  } finally {
    vi.useRealTimers();
  }
});

test("legacy reconnect resets retry delay to 250ms", async () => {
  vi.useFakeTimers();
  try {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return jsonResponse({ detail: "busy" }, 503);
    }));
    const q = createOpQueue(null, () => undefined);
    await q.enqueue([op("u1")]).settled;
    await q.drain();
    await vi.advanceTimersByTimeAsync(250); // second failure schedules 1s
    expect(calls).toBe(2);

    q.setOnline(false);
    q.setOnline(true); // immediate failure; reconnect resets backoff
    await q.drain();
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

test.each([
  ["offline", (q: ReturnType<typeof createOpQueue>) => q.setOnline(false)],
  ["recovering", (q: ReturnType<typeof createOpQueue>) => q.pause("recovery")],
  ["disposed", (q: ReturnType<typeof createOpQueue>) => q.dispose()],
] as const)("legacy failure returns the current %s terminal state",
async (reason, transition) => {
  let rejectPost!: (error: unknown) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => {
    rejectPost = reject;
  })));
  const q = createOpQueue(null, () => undefined);
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
