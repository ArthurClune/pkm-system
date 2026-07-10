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
  const q = createOpQueue(() => undefined);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2"), op("u3")]);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(bodies[0]).toEqual({
    client_id: clientId,
    ops: [op("u1"), op("u2"), op("u3")],
  });
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
  const q = createOpQueue(() => undefined);
  q.enqueue([op("u1")]);
  await Promise.resolve(); // let the first batch dispatch
  q.enqueue([op("u2")]);
  release();
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u2")]);
});

test("a failed batch clears the queue and reports desync; queue keeps working", async () => {
  const { mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const onDesync = vi.fn();
  const q = createOpQueue(onDesync);
  q.enqueue([op("u1"), op("u2")]);
  await q.idle();
  expect(onDesync).toHaveBeenCalledTimes(1);
  // queue survives: a later enqueue sends normally
  q.enqueue([op("u3")]);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
});

test("ops re-enqueued synchronously from onDesync are not stranded", async () => {
  const { bodies, mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const q = createOpQueue(() => {
    q.enqueue([op("u9")]);
  });
  q.enqueue([op("u1")]);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u9")]);
});

test("a throwing onDesync does not poison the queue or idle()", async () => {
  const { mock } = capturingFetch([
    () => jsonResponse({ detail: { index: 0, reason: "boom" } }, 400),
    () => jsonResponse({ ok: true }),
  ]);
  const q = createOpQueue(() => {
    throw new Error("desync handler exploded");
  });
  q.enqueue([op("u1")]);
  await q.idle(); // must resolve, not reject
  // queue survives: a later enqueue sends normally
  q.enqueue([op("u2")]);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
});

test("while offline, enqueue is preserved but pumps no HTTP", async () => {
  const { mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(() => undefined);
  q.setOnline(false);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2")]);
  await q.idle();
  await Promise.resolve(); // give any stray microtask a chance to POST
  expect(mock).not.toHaveBeenCalled();
});

test("reconnect flushes the ops preserved while offline, in order", async () => {
  const { bodies, mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(() => undefined);
  q.setOnline(false);
  q.enqueue([op("u1")]);
  q.enqueue([op("u2")]);
  q.setOnline(true);
  await q.idle();
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
  const q = createOpQueue(() => undefined);
  q.enqueue([op("u1")]);   // connected: pump starts, POST for u1 in flight
  await Promise.resolve(); // let that batch dispatch
  q.setOnline(false);      // socket drops while the POST is outstanding
  q.enqueue([op("u2")]);   // enqueued while offline -> must stay pending
  release();               // the in-flight POST's response arrives
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(1); // u2 did NOT start a new pump
  q.setOnline(true);       // reconnect flushes the preserved op
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[1] as { ops: unknown[] }).ops).toEqual([op("u2")]);
});

test("batches larger than 500 ops split into sequential POSTs", async () => {
  const { bodies, mock } = capturingFetch([() => jsonResponse({ ok: true })]);
  const q = createOpQueue(() => undefined);
  const ops = Array.from({ length: 501 }, (_, i) => op(`u${i}`));
  q.enqueue(ops);
  await q.idle();
  expect(mock).toHaveBeenCalledTimes(2);
  expect((bodies[0] as { ops: unknown[] }).ops).toHaveLength(500);
  expect((bodies[1] as { ops: unknown[] }).ops).toHaveLength(1);
});
