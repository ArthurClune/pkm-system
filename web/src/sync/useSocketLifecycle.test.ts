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
