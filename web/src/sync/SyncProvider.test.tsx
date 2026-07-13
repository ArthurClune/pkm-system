import { act, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { FakeWebSocket, stubFetch } from "../test-helpers";
import { apiFetch } from "../api/client";
import type { WsBatch } from "./socket";
import { clientId } from "./opQueue";
import { SyncProvider, useSync, type Sync } from "./SyncProvider";

function Probe({ onBatch }: { onBatch: (b: WsBatch) => void }) {
  const sync = useSync();
  useEffect(() => sync.subscribe(onBatch), [sync, onBatch]);
  return <div data-testid="status">{sync.status}:{sync.resyncSeq}</div>;
}

beforeEach(() => {
  stubFetch([["/api/ops", { ok: true }]]);
});

function lastWs(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

test("status: connecting -> connected -> reconnecting -> connected, resync bump on re-open", async () => {
  vi.useFakeTimers();
  const onBatch = vi.fn();
  render(<SyncProvider><Probe onBatch={onBatch} /></SyncProvider>);
  expect(screen.getByTestId("status").textContent).toBe("connecting:0");
  act(() => lastWs().open());
  expect(screen.getByTestId("status").textContent).toBe("connected:0");
  act(() => lastWs().drop());
  expect(screen.getByTestId("status").textContent).toBe("reconnecting:0");
  act(() => { vi.advanceTimersByTime(2000); }); // reconnect timer -> new socket
  // the resync bump is deferred until the preserved queue has flushed (idle)
  await act(async () => { lastWs().open(); });
  // re-established after a gap: views must refetch (resyncSeq bumped)
  expect(screen.getByTestId("status").textContent).toBe("connected:1");
  vi.useRealTimers();
});

test("on reconnect, resyncSeq bumps only after the preserved queue has flushed", async () => {
  vi.useFakeTimers();
  let releasePost!: () => void;
  const postGate = new Promise<void>((r) => { releasePost = r; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith("/api/ops")) await postGate;
    return new Response(JSON.stringify({ ok: true }),
      { status: 200, headers: { "Content-Type": "application/json" } });
  }));

  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return <div data-testid="status">{sync.status}:{sync.resyncSeq}</div>;
  }
  render(<SyncProvider><Grab /></SyncProvider>);
  act(() => lastWs().open());  // first connect
  act(() => lastWs().drop());  // offline: queue paused
  act(() => sync.enqueue([{ op: "delete", uid: "u1" }])); // preserved, not sent
  act(() => { vi.advanceTimersByTime(2000); }); // socket reconnect timer
  await act(async () => { lastWs().open(); }); // reconnect: flush starts (gated)

  // the flush POST is still outstanding, so the refetch must not be signalled
  expect(screen.getByTestId("status").textContent).toBe("connected:0");
  await act(async () => { releasePost(); }); // flush completes
  expect(screen.getByTestId("status").textContent).toBe("connected:1");
  vi.useRealTimers();
});

test("dispatches remote batches to subscribers, filters own echoes", () => {
  const onBatch = vi.fn();
  render(<SyncProvider><Probe onBatch={onBatch} /></SyncProvider>);
  act(() => lastWs().open());
  const remote = { client_id: "someone-else", ts: 1,
                   ops: [{ op: "delete", uid: "u1" }] };
  act(() => lastWs().message(remote));
  act(() => lastWs().message({ client_id: clientId, ts: 2, ops: [] }));
  expect(onBatch).toHaveBeenCalledTimes(1);
  expect(onBatch).toHaveBeenCalledWith(remote);
});

test("ignores non-batch frames (e.g. a seq nudge), still dispatches batches", () => {
  const onBatch = vi.fn();
  render(<SyncProvider><Probe onBatch={onBatch} /></SyncProvider>);
  act(() => lastWs().open());
  act(() => lastWs().message({ type: "seq", seq: 42 }));
  expect(onBatch).not.toHaveBeenCalled();
  const remote = { client_id: "someone-else", ts: 1,
                   ops: [{ op: "delete", uid: "u1" }] };
  act(() => lastWs().message(remote));
  expect(onBatch).toHaveBeenCalledTimes(1);
  expect(onBatch).toHaveBeenCalledWith(remote);
});

test("connects to /api/ws on the current host", () => {
  render(<SyncProvider><div /></SyncProvider>);
  expect(lastWs().url).toMatch(/^ws{1,2}:\/\/.+\/api\/ws$/);
});

test("enqueue outside a provider throws instead of dropping writes", () => {
  let sync: Sync | undefined;
  function Probe() {
    sync = useSync();
    return null;
  }
  render(<Probe />);
  expect(() => sync!.enqueue([])).toThrow(/SyncProvider/);
});

// --- replica lifecycle (pkm-y8p0) ---

import type { Replica } from "../replica/client";

function fakeReplicaForProvider(): Replica & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    init: async () => {
      log.push("init");
      return { ok: true, empty: true, cursor: 0, schemaMismatch: false,
               pendingBatches: [] };
    },
    applySnapshot: async () => { log.push("applySnapshot"); },
    applyChanges: async (f) => {
      log.push("applyChanges");
      return { status: "applied", cursor: f.next_since };
    },
    enqueue: async () => ({ pending: 0 }),
    nextBatch: async () => null,
    pendingBatches: async () => [],
    deleteBatch: async () => ({ pending: 0 }),
    markPoisoned: async () => ({ pending: 0 }),
    pendingCount: async () => 0,
    localApi: async () => ({ handled: false as const }),
    reset: async () => undefined,
  };
}

const SNAPSHOT = { generation: "g1", seq: 5, pages: [], blocks: [], sidebar: [] };
const EMPTY_FEED = { reset: false, generation: "g1", next_since: 5,
                     latest_seq: 5, pages: [], blocks: [], sidebar: [],
                     tombstones: [] };

test("first connect bootstraps an empty replica and reports ready", async () => {
  const fetchMock = stubFetch([
    ["/api/sync/snapshot", SNAPSHOT],
    ["/api/sync/changes", EMPTY_FEED],
    ["/api/ops", { ok: true }],
  ]);
  const replica = fakeReplicaForProvider();
  function Mode() {
    return <div data-testid="mode">{useSync().replicaMode}</div>;
  }
  render(<SyncProvider replica={replica}><Mode /></SyncProvider>);
  expect(screen.getByTestId("mode").textContent).toBe("starting");
  await act(async () => { lastWs().open(); });
  expect(replica.log).toContain("applySnapshot");
  expect(screen.getByTestId("mode").textContent).toBe("ready");
  const urls = fetchMock.mock.calls.map((c) => String(c[0]));
  expect(urls).toContain("/api/sync/snapshot");
});

test("a WS seq nudge beyond the cursor pulls the changes feed", async () => {
  const fetchMock = stubFetch([
    ["/api/sync/snapshot", SNAPSHOT],
    ["/api/sync/changes", { ...EMPTY_FEED, next_since: 9, latest_seq: 9 }],
    ["/api/ops", { ok: true }],
  ]);
  const replica = fakeReplicaForProvider();
  render(<SyncProvider replica={replica}><div /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  const before = fetchMock.mock.calls.length;
  await act(async () => { lastWs().message({ type: "seq", seq: 12 }); });
  const changeCalls = fetchMock.mock.calls.slice(before)
    .map((c) => String(c[0]))
    .filter((u) => u.startsWith("/api/sync/changes"));
  expect(changeCalls).toEqual(["/api/sync/changes?since=9"]);
});

test("without a replica the provider reports no-replica mode", async () => {
  stubFetch([["/api/ops", { ok: true }]]);
  function Mode() {
    return <div data-testid="mode">{useSync().replicaMode}</div>;
  }
  render(<SyncProvider replica={null}><Mode /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  expect(screen.getByTestId("mode").textContent).toBe("no-replica");
});

test("leftover durable batches flush on first connect, then views resync", async () => {
  // a reload can kill an in-flight POST: the next session's first connect
  // must drain the leftover AND refetch views (they loaded server state
  // that predates the flush; the WS echo is filtered as this tab's own)
  const fetchMock = stubFetch([
    ["/api/sync/snapshot", SNAPSHOT],
    ["/api/sync/changes", EMPTY_FEED],
    ["/api/ops", { ok: true }],
  ]);
  const replica = fakeReplicaForProvider();
  const rows = [{ id: 1, batch_id: "leftover",
                  ops: [{ op: "delete", uid: "u1" } as const], poisoned: false }];
  replica.pendingCount = async () => rows.length;
  replica.nextBatch = async () => rows[0] ?? null;
  replica.deleteBatch = async () => { rows.pop(); return { pending: 0 }; };
  render(<SyncProvider replica={replica}><Probe onBatch={() => undefined} /></SyncProvider>);
  await act(async () => { lastWs().open(); }); // first connect of this load
  expect(rows).toEqual([]); // drained
  const opsPosts = fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/ops");
  expect(opsPosts.length).toBe(1);
  expect(screen.getByTestId("status").textContent).toBe("connected:1"); // resync
});

test("gateway: requests reach the network until the socket has actually dropped", async () => {
  stubFetch([
    ["/api/sync/snapshot", SNAPSHOT],
    ["/api/sync/changes", EMPTY_FEED],
    ["/api/ops", { ok: true }],
    ["/api/x", { net: true }],
  ]);
  const replica = fakeReplicaForProvider();
  replica.localApi = async () =>
    ({ handled: true, status: 200, body: { local: true } });
  const { unmount } = render(<SyncProvider replica={replica}><div /></SyncProvider>);
  // "connecting" is not offline: the network is reachable before the socket
  // finishes its handshake (a reload lands here with hot caches)
  await expect(apiFetch("/api/x")).resolves.toEqual({ net: true });
  await act(async () => { lastWs().open(); });
  await expect(apiFetch("/api/x")).resolves.toEqual({ net: true });
  // only a dropped socket routes reads to the replica shim
  await act(async () => { lastWs().drop(); });
  await expect(apiFetch("/api/x")).resolves.toEqual({ local: true });
  unmount(); // deregisters the gateway for later tests
});

test("offline with a ready replica keeps editing enabled and counts pending", async () => {
  stubFetch([
    ["/api/sync/snapshot", SNAPSHOT],
    ["/api/sync/changes", EMPTY_FEED],
    ["/api/ops", { ok: true }],
  ]);
  const replica = fakeReplicaForProvider();
  let pendingN = 2;
  replica.pendingCount = async () => pendingN;
  replica.enqueue = async () => ({ pending: ++pendingN });
  replica.nextBatch = async () => null; // nothing drains in this test
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return <div data-testid="s">{String(sync.canEdit)}:{sync.pending}</div>;
  }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  await act(async () => { lastWs().drop(); }); // offline
  expect(sync.status).toBe("reconnecting");
  expect(sync.canEdit).toBe(true); // replica ready: editing continues
  expect(sync.pending).toBe(2);    // durable queue from a previous session
  await act(async () => { sync.enqueue([{ op: "delete", uid: "u1" }]); await sync.idle(); });
  expect(sync.pending).toBe(3);
  expect(sync.readOnlyReason).toBeUndefined();
});

test("offline without a replica stays read-only with a reason", async () => {
  stubFetch([["/api/ops", { ok: true }]]);
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return null;
  }
  render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  await act(async () => { lastWs().drop(); });
  expect(sync.canEdit).toBe(false);
  expect(sync.readOnlyReason).toMatch(/offline/);
});
