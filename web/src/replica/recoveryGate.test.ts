import { expect, test } from "vitest";
import { createRecoveryGate } from "./recoveryGate";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("prepare is a FIFO barrier and later work waits for abort", async () => {
  const gate = createRecoveryGate(() => "lease-1");
  const earlier = deferred();
  const earlierStarted = deferred();
  const trace: string[] = [];
  const first = gate.run(async () => {
    trace.push("earlier-start");
    earlierStarted.resolve();
    await earlier.promise;
    trace.push("earlier-end");
  });
  const preparing = gate.prepare(() => {
    trace.push("prepare");
    return "captured";
  });

  await earlierStarted.promise;
  expect(trace).toEqual(["earlier-start"]);
  earlier.resolve();
  const lease = await preparing;
  expect(lease).toEqual({ token: "lease-1", value: "captured" });

  const later1 = gate.run(() => { trace.push("later-1"); });
  const later2 = gate.run(() => { trace.push("later-2"); });
  await Promise.resolve();
  expect(trace).toEqual(["earlier-start", "earlier-end", "prepare"]);

  await gate.abort(lease.token);
  await Promise.all([first, later1, later2]);
  expect(trace).toEqual([
    "earlier-start", "earlier-end", "prepare", "later-1", "later-2",
  ]);
});

test("a failing commit releases once and rejects invalid or reused tokens", async () => {
  const gate = createRecoveryGate(() => "lease-1");
  const lease = await gate.prepare(() => undefined);

  await expect(gate.commit("wrong-token", () => undefined))
    .rejects.toThrow("invalid or inactive recovery token");
  await expect(gate.commit(lease.token, () => {
    throw new Error("commit failed");
  })).rejects.toThrow("commit failed");
  await expect(gate.abort(lease.token))
    .rejects.toThrow("invalid or inactive recovery token");
  await expect(gate.run(() => "not wedged")).resolves.toBe("not wedged");
});

test("a failed prepare releases its FIFO slot", async () => {
  const gate = createRecoveryGate(() => "lease-1");
  await expect(gate.prepare(() => {
    throw new Error("capture failed");
  })).rejects.toThrow("capture failed");
  await expect(gate.run(() => "continued")).resolves.toBe("continued");
});
