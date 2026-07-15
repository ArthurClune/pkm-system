import { expect, test, vi } from "vitest";
import {
  ReplicaError,
  RpcLifecycleError,
  createRpcClient,
  serveRpc,
  type PortLike,
  toPortLike,
} from "./rpc";

function pair() {
  const ch = new MessageChannel();
  return { server: toPortLike(ch.port2), client: toPortLike(ch.port1) };
}

test("routes calls to handlers and returns results", async () => {
  const { server, client } = pair();
  serveRpc(server, {
    echo: async (payload) => ({ got: payload }),
  });
  const rpc = createRpcClient(client);
  await expect(rpc.call("echo", 42)).resolves.toEqual({ got: 42 });
});

test("interleaved calls resolve to their own callers", async () => {
  const { server, client } = pair();
  serveRpc(server, {
    double: async (n) => (n as number) * 2,
  });
  const rpc = createRpcClient(client);
  const [a, b, c] = await Promise.all(
    [1, 2, 3].map((n) => rpc.call<number>("double", n)));
  expect([a, b, c]).toEqual([2, 4, 6]);
});

test("handler errors reject with ReplicaError, quota flag preserved", async () => {
  const { server, client } = pair();
  const quotaErr = Object.assign(new Error("db full"), { quota: true });
  serveRpc(server, {
    boom: async () => { throw new Error("plain failure"); },
    quotaBoom: async () => { throw quotaErr; },
  });
  const rpc = createRpcClient(client);
  await expect(rpc.call("boom")).rejects.toThrow("plain failure");
  const err = await rpc.call("quotaBoom").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReplicaError);
  expect((err as ReplicaError).quota).toBe(true);
});

test("unknown method rejects", async () => {
  const { server, client } = pair();
  serveRpc(server, {});
  const rpc = createRpcClient(client);
  await expect(rpc.call("nope")).rejects.toThrow("unknown replica method: nope");
});

class ControlledPort implements PortLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { error?: unknown; message?: string }) => void) | null = null;
  onmessageerror: ((ev: { data?: unknown }) => void) | null = null;
  sent: Array<{ id: number; method: string }> = [];

  postMessage(msg: unknown): void {
    this.sent.push(msg as { id: number; method: string });
  }

  reply(id: number, result: unknown): void {
    this.onmessage?.({ data: { id, result } });
  }
}

test.each([
  ["worker-error", (port: ControlledPort) =>
    port.onerror?.({ error: new Error("worker crashed") })],
  ["message-error", (port: ControlledPort) =>
    port.onmessageerror?.({ data: "uncloneable" })],
] as const)("%s rejects every pending call and ignores late replies",
async (kind, fail) => {
  const port = new ControlledPort();
  const rpc = createRpcClient(port);
  const first = rpc.call("first");
  const second = rpc.call("second");

  fail(port);

  await expect(first).rejects.toMatchObject({ kind });
  await expect(second).rejects.toMatchObject({ kind });
  port.reply(port.sent[0].id, "late");
  port.reply(port.sent[1].id, "late");
  await expect(rpc.call("after-terminal")).rejects.toMatchObject({ kind });
});

test("timeouts reject and remove each pending call without poisoning the client", async () => {
  vi.useFakeTimers();
  try {
    const port = new ControlledPort();
    const rpc = createRpcClient(port);
    const first = rpc.call("first", undefined, { timeoutMs: 10 })
      .catch((error: unknown) => error);
    const second = rpc.call("second", undefined, { timeoutMs: 20 })
      .catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(20);

    await expect(first).resolves.toMatchObject({ kind: "timeout" });
    await expect(second).resolves.toMatchObject({ kind: "timeout" });
    port.reply(port.sent[0].id, "late");
    port.reply(port.sent[1].id, "late");
    const third = rpc.call<string>("third", undefined, { timeoutMs: 10 });
    port.reply(port.sent[2].id, "ok");
    await expect(third).resolves.toBe("ok");
  } finally {
    vi.useRealTimers();
  }
});

test("dispose rejects pending and future calls with an idempotent typed cause", async () => {
  const port = new ControlledPort();
  const rpc = createRpcClient(port);
  const first = rpc.call("first");
  const second = rpc.call("second");
  const reason = new Error("provider unmounted");

  rpc.dispose(reason);
  rpc.dispose(new Error("ignored second disposal"));

  await expect(first).rejects.toEqual(expect.objectContaining({
    kind: "disposed",
    cause: reason,
  }));
  await expect(second).rejects.toBeInstanceOf(RpcLifecycleError);
  port.reply(port.sent[0].id, "late");
  await expect(rpc.call("after-dispose")).rejects.toMatchObject({
    kind: "disposed",
    cause: reason,
  });
});
