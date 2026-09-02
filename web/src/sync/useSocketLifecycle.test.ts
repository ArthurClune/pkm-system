import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { FakeWebSocket } from "../test-helpers";
import type { OpQueue } from "./opQueue";
import type { ReplicaSync } from "./replicaSync";
import type { SyncStatus } from "./syncState";
import { useSocketLifecycle, type SocketLifecycleDeps } from "./useSocketLifecycle";

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

/** A queue whose drain always reports success at once — the reconnect flow
 * under test needs nothing more than that to reach replicaSync.start(). */
function fakeQueue(): OpQueue {
  return {
    setOnline: () => undefined,
    dispose: () => undefined,
    drain: async () => ({ status: "drained" }),
  } as unknown as OpQueue;
}

function fakeDeps(over: Partial<SocketLifecycleDeps> = {}): SocketLifecycleDeps {
  return {
    queue: fakeQueue(),
    replicaSync: null,
    readInitialPending: async () => 0,
    startupRun: async () => undefined,
    mountedRef: { current: true },
    statusRef: { current: "connecting" as SyncStatus },
    drainObserverRef: { current: () => undefined },
    onBatch: () => undefined,
    onSeq: () => undefined,
    onStatus: () => undefined,
    onResync: () => undefined,
    disposeOwned: () => undefined,
    ...over,
  };
}

afterEach(() => { vi.restoreAllMocks(); });

test("a first-connect reconnect().begin() rejection is logged, not left unhandled (pkm-fgjg)",
async () => {
  // reconnectFlow's begin() does not swallow (unlike observeDrain, which
  // wraps its own finish() in a .catch). A non-empty durable queue on first
  // connect drives begin({ viewsAreStale: true }) through
  // useSocketLifecycle.ts's initialPending chain; if replicaSync.start()
  // throws, that must not become an unhandled rejection.
  const boom = new Error("replica start failed");
  const replicaSync = {
    start: async () => { throw boom; },
    idle: async () => undefined,
    appliedVersion: () => null,
    hasStarted: () => true,
    stop: () => undefined,
  } as unknown as ReplicaSync;
  const logged: unknown[][] = [];
  vi.spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => { logged.push(args); });

  renderHook(() => useSocketLifecycle(fakeDeps({
    replicaSync,
    readInitialPending: async () => 1, // leftover durable rows: begin() runs
  })));

  await act(async () => {
    lastWs().open();
    // Flush the initialPending -> startupRun -> begin -> drain -> finish ->
    // replicaSync.start() microtask chain without relying on fake timers.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(logged.some((args) => args.includes(boom))).toBe(true);
});

test("a reconnect's begin() rejection is logged, not left unhandled (pkm-fgjg)", async () => {
  const boom = new Error("replica start failed");
  const replicaSync = {
    start: async () => { throw boom; },
    idle: async () => undefined,
    appliedVersion: () => null,
    hasStarted: () => true,
    stop: () => undefined,
  } as unknown as ReplicaSync;
  const logged: unknown[][] = [];
  vi.spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => { logged.push(args); });

  renderHook(() => useSocketLifecycle(fakeDeps({ replicaSync })));

  // First connect: an empty durable queue skips begin() entirely (see the
  // other test), so this establishes everConnectedRef without tripping it.
  await act(async () => {
    lastWs().open();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(logged).toEqual([]);

  // A genuine reconnect (drop, then a fresh open) takes the unconditional
  // `void reconnect.begin()` branch.
  await act(async () => {
    lastWs().drop();
    lastWs().open();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(logged.some((args) => args.includes(boom))).toBe(true);
});

test("offline cold start with an empty queue still bootstraps once online (pkm-8k2c)",
async () => {
  // The mount-time startupRun() already tried replicaSync.start() before the
  // first connect (SyncProvider.tsx's own effect); while offline that attempt's
  // snapshot fetch fails and the failure is swallowed upstream, leaving the
  // replica un-started with an empty durable queue. The old gate
  // (`n > 0` alone) then never called begin() at all, so nothing retried the
  // bootstrap once connectivity returned -- views stayed empty until a reload.
  let started = false;
  const startCalls: number[] = [];
  const replicaSync = {
    start: async () => { startCalls.push(startCalls.length); started = true; },
    idle: async () => undefined,
    appliedVersion: () => (started ? 1 : 0),
    hasStarted: () => started,
    stop: () => undefined,
  } as unknown as ReplicaSync;

  renderHook(() => useSocketLifecycle(fakeDeps({
    replicaSync,
    readInitialPending: async () => 0, // empty durable queue
  })));

  await act(async () => {
    lastWs().open(); // connectivity returns: the socket's first "up"
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(startCalls.length).toBe(1);
});

test("online cold start with an already-bootstrapped replica and empty queue " +
"stays quiet (pkm-8k2c)", async () => {
  // Widening the gate must not make every first connect redundantly re-run
  // the reconnect protocol: a replica that mount-time startupRun() already
  // got to "ready" (this session, or reading data persisted from a previous
  // one) has nothing left for begin() to do when the queue is empty.
  const startCalls: number[] = [];
  const replicaSync = {
    start: async () => { startCalls.push(startCalls.length); },
    idle: async () => undefined,
    appliedVersion: () => 0,
    hasStarted: () => true,
    stop: () => undefined,
  } as unknown as ReplicaSync;

  renderHook(() => useSocketLifecycle(fakeDeps({
    replicaSync,
    readInitialPending: async () => 0,
  })));

  await act(async () => {
    lastWs().open();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(startCalls.length).toBe(0);
});
