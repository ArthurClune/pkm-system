import { describe, expect, it } from "vitest";
import type { BatchId, SyncSeq } from "../../api/brands";
import type { Snapshot } from "../../replica/apply";
import { cancellable, ExampleCancelled } from "./cancel";
import type { ServerControl } from "./serverControl";

/** A ServerControl that records each call by name. */
function fakeServer(calls: string[]): ServerControl {
  const note = (name: string): Promise<void> => {
    calls.push(name);
    return Promise.resolve();
  };
  return {
    cookie: "session=x",
    reset: () => note("reset"),
    setClock: () => note("setClock"),
    rotateGeneration: () => note("rotateGeneration"),
    applied: async () => { await note("applied"); return [] as { batch_id: BatchId; applied_at: number }[]; },
    snapshot: async () => { await note("snapshot"); return {} as Snapshot; },
    latestSeq: async () => { await note("latestSeq"); return 7 as SyncSeq; },
    postRaw: async () => { await note("postRaw"); return new Response(null); },
    withSignal: () => fakeServer(calls),
  };
}

const everyCall = (s: ServerControl): Promise<unknown>[] => [
  s.reset(), s.setClock(0), s.rotateGeneration(), s.applied(), s.snapshot(),
  s.latestSeq(), s.postRaw("{}"),
];

describe("cancellable", () => {
  it("passes every call through until cancelled", async () => {
    const calls: string[] = [];
    const guard = cancellable(fakeServer(calls));
    expect(guard.server.cookie).toBe("session=x");
    await Promise.all(everyCall(guard.server));
    expect(await guard.server.latestSeq()).toBe(7);
    expect(calls).toHaveLength(8);
    expect(guard.cancelled()).toBe(false);
  });

  it("refuses every call, the cookie included, once cancelled", async () => {
    const calls: string[] = [];
    const inner = fakeServer(calls);
    const guard = cancellable(inner);
    guard.cancel();
    expect(guard.cancelled()).toBe(true);
    expect(() => guard.server.cookie).toThrow(ExampleCancelled);
    for (const call of everyCall(guard.server)) {
      await expect(call).rejects.toBeInstanceOf(ExampleCancelled);
    }
    expect(calls).toEqual([]);
    // The shared control is untouched.
    await inner.reset();
    expect(calls).toEqual(["reset"]);
  });

  it("aborts its signal on cancel, and a call already pending with it", async () => {
    let pending: Promise<Response> | null = null;
    const inner: ServerControl = {
      ...fakeServer([]),
      // A request that waits on the wire until its signal aborts.
      withSignal: (signal) => ({
        ...fakeServer([]),
        postRaw: () => {
          pending = new Promise<Response>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason));
          });
          return pending;
        },
      }),
    };
    const guard = cancellable(inner);
    expect(guard.signal.aborted).toBe(false);
    const call = guard.server.postRaw("{}");
    guard.cancel();
    expect(guard.signal.aborted).toBe(true);
    await expect(call).rejects.toBeDefined();
  });
});
