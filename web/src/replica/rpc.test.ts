import { expect, test } from "vitest";
import { ReplicaError, createRpcClient, serveRpc } from "./rpc";

function pair() {
  const ch = new MessageChannel();
  return { server: ch.port2, client: ch.port1 };
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
