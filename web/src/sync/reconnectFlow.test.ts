import { expect, test, vi } from "vitest";
import { createReconnectFlow } from "./reconnectFlow";
import type { DrainOutcome } from "./opQueue";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function harness(opts: {
  drain?: () => Promise<DrainOutcome>;
  replicaSync?: { start: () => Promise<void>; idle: () => Promise<void> } | null;
  mounted?: () => boolean;
} = {}) {
  const trace: string[] = [];
  const drain = opts.drain ?? (async () => {
    trace.push("drain");
    return { status: "drained" as const };
  });
  const replicaSync = opts.replicaSync === undefined ? {
    start: async () => { trace.push("start"); },
    idle: async () => { trace.push("idle"); },
  } : opts.replicaSync;
  const flow = createReconnectFlow({
    queue: { drain: () => drain() },
    replicaSync,
    isMounted: opts.mounted ?? (() => true),
    onResync: () => { trace.push("resync"); },
  });
  return { flow, trace };
}

test("a reconnect flushes, pulls the feed, then bumps resync in that order", async () => {
  const { flow, trace } = harness();

  await flow.begin();

  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
});

test("a blocked drain neither pulls the feed nor bumps resync", async () => {
  const { flow, trace } = harness({
    drain: async () => ({ status: "blocked", reason: "retryable", pending: 1 }),
  });

  await flow.begin();

  expect(trace).toEqual([]);
});

test("a drain that completes out of band finishes the waiting reconnect", async () => {
  // The queue's automatic retry, not this flow, is what got the batch through:
  // begin() has already returned "blocked", so only the drain observer can
  // complete the reconnect that is still waiting on it.
  const blocked = gate();
  let firstDrain = true;
  const { flow, trace } = harness({
    drain: async () => {
      if (!firstDrain) return { status: "drained" };
      firstDrain = false;
      await blocked.promise;
      return { status: "blocked", reason: "retryable", pending: 1 };
    },
  });

  const running = flow.begin();
  blocked.release();
  await running;
  expect(trace).toEqual([]);

  flow.observeDrain({ status: "drained" });
  await Promise.resolve();
  await vi.waitFor(() => { expect(trace).toEqual(["start", "idle", "resync"]); });
});

test("a drain observed with no reconnect intent does nothing", async () => {
  // Routine delivery drains constantly; only a reconnect may pull + resync.
  const { flow, trace } = harness();

  flow.observeDrain({ status: "drained" });
  flow.observeDrain({ status: "blocked", reason: "offline", pending: 0 });
  await Promise.resolve();

  expect(trace).toEqual([]);
});

test("overlapping reconnects share one completion and leave no stale intent",
async () => {
  const feed = gate();
  const { flow, trace } = harness({
    replicaSync: {
      start: async () => { trace.push("start"); },
      idle: async () => { trace.push("idle"); await feed.promise; },
    },
  });

  const first = flow.begin();
  await vi.waitFor(() => { expect(trace).toContain("idle"); });
  const second = flow.begin();   // second connect joins the running completion

  feed.release();
  await Promise.all([first, second]);

  expect(trace).toEqual(["drain", "start", "idle", "drain", "resync"]);

  // The joined run consumed the second intent too: a later stray drain must
  // not resync again.
  flow.observeDrain({ status: "drained" });
  await Promise.resolve();
  expect(trace.filter((step) => step === "resync")).toHaveLength(1);
});

test("nothing finishes or resyncs after unmount", async () => {
  let mounted = true;
  const { flow, trace } = harness({ mounted: () => mounted });

  mounted = false;
  await flow.begin();
  flow.observeDrain({ status: "drained" });
  await Promise.resolve();

  expect(trace).toEqual(["drain"]);
});

test("a no-replica session still bumps resync on reconnect (pkm-9x6u)", async () => {
  const { flow, trace } = harness({ replicaSync: null });

  await flow.begin();

  expect(trace).toEqual(["drain", "resync"]);
});
