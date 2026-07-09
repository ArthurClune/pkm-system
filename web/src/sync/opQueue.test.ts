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
