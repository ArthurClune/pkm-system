import { act, render, screen } from "@testing-library/react";
import { StrictMode, useEffect } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import type { BlockOp } from "../api/ops";
import { DndProvider, useDnd } from "../dnd/DndContext";
import { acquireOutlineSession } from "../outline/outlineSessions";
import { block, FakeWebSocket, jsonResponse, stubFetch } from "../test-helpers";
import { apiFetch } from "../api/client";
import type { WsBatch } from "./socket";
import { clientId, createOpQueue } from "./opQueue";
import { SyncProvider, useSync, type Sync } from "./SyncProvider";

function Probe({ onBatch }: { onBatch: (b: WsBatch) => void }) {
  const sync = useSync();
  useEffect(() => sync.subscribe(onBatch), [sync, onBatch]);
  return <div data-testid="status">{sync.status}:{sync.resyncSeq}</div>;
}

beforeEach(() => {
  localStorage.clear();
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
  // the resync bump is deferred until the preserved queue has drained
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
    poisonedBatches: async () => [],
    deleteBatch: async () => ({ pending: 0 }),
    markPoisoned: async () => ({ pending: 0 }),
    pendingCount: async () => 0,
    localApi: async () => ({ handled: false as const }),
    prepareRecovery: async () => ({ token: "lease-1", batches: [] }),
    commitRecovery: async () => undefined,
    abortRecovery: async () => undefined,
    reset: async () => undefined,
    dispose: async () => { log.push("dispose"); },
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

test("empty legacy repair resumes a wholly later ticket after drain handoff", async () => {
  let postCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/ops") return jsonResponse({ ok: true });
    postCount += 1;
    return postCount === 1
      ? jsonResponse({ detail: "bad op" }, 400)
      : jsonResponse({ ok: true });
  }));
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return null;
  }
  const view = render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  let later: ReturnType<Sync["enqueue"]> | undefined;
  try {
    const rejected = sync.enqueue(Array.from(
      { length: 500 }, (_, i) => ({ op: "delete" as const, uid: `bad-${i}` }),
    ));
    later = sync.enqueue([{ op: "delete", uid: "later" }]);

    await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(postCount).toBe(2));
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  } finally {
    view.unmount();
  }
});

test("legacy repair rebases an unmounted cross-page target before resuming its move", async () => {
  const sourceTitle = "Unmounted replay source";
  const targetTitle = "Unmounted replay target";
  const moved = block("moved", "moved", {
    children: [block("child", "child")],
  });
  const sourceTree = [block("source-root", "source", {
    children: [moved],
  })];
  const targetTree = [block("target-root", "target", {
    children: [block("existing", "existing")],
  })];
  let releaseSourceRepair!: () => void;
  const sourceRepairGate = new Promise<void>((done) => {
    releaseSourceRepair = done;
  });
  const source = acquireOutlineSession(sourceTitle, sourceTree);
  const sourceLoad = vi.fn(async () => {
    await sourceRepairGate;
    return sourceTree;
  });
  const removeSourceLoader = source.setAuthoritativeLoader(sourceLoad);
  let target: ReturnType<typeof acquireOutlineSession> | undefined;
  let removeTargetLoader: (() => void) | undefined;
  let targetAtResume: ReturnType<
    ReturnType<typeof acquireOutlineSession>["getSnapshot"]
  > | undefined;
  let postCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/ops") return jsonResponse({ ok: true });
    postCount += 1;
    if (postCount === 1) return jsonResponse({ detail: "bad op" }, 400);
    targetAtResume = target?.getSnapshot();
    return jsonResponse({ ok: true });
  }));

  let sync!: Sync;
  let dnd!: ReturnType<typeof useDnd>;
  function Grab() {
    sync = useSync();
    dnd = useDnd();
    return null;
  }
  const view = render(
    <SyncProvider replica={null}>
      <DndProvider><Grab /></DndProvider>
    </SyncProvider>,
  );
  const sourceDnd = {
    moveTo: vi.fn(),
    removeSubtreeLocal: vi.fn(() => moved),
    insertSubtreeLocal: vi.fn(),
  };
  const sourceRegistration = dnd.registerOutline(sourceTitle, sourceDnd);
  try {
    const rejected = sync.enqueue(Array.from(
      { length: 500 }, (_, i) => ({ op: "delete" as const, uid: `bad-${i}` }),
    ), ["page", sourceTitle]);
    dnd.drop(
      { uid: "moved", pageTitle: sourceTitle },
      { parent_uid: "target-root", order_idx: 1, page_title: targetTitle },
    );

    await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(sourceLoad).toHaveBeenCalledTimes(1));
    target = acquireOutlineSession(targetTitle, targetTree);
    const targetLoad = vi.fn(async () => targetTree);
    removeTargetLoader = target.setAuthoritativeLoader(targetLoad);
    expect(postCount).toBe(1);

    releaseSourceRepair();
    await vi.waitFor(() => expect(targetLoad).toHaveBeenCalled());
    await vi.waitFor(() => expect(postCount).toBe(2));
    expect(targetAtResume?.blocks[0]).toMatchObject({
      uid: "target-root",
      children: [
        expect.objectContaining({ uid: "existing", order_idx: 0 }),
        expect.objectContaining({
          uid: "moved",
          order_idx: 1,
          children: [expect.objectContaining({ uid: "child" })],
        }),
      ],
    });
    await vi.waitFor(() => expect(sync.pending).toBe(0));
  } finally {
    releaseSourceRepair();
    if (sourceRegistration.accepted) sourceRegistration.unregister();
    view.unmount();
    removeTargetLoader?.();
    target?.release();
    removeSourceLoader();
    source.release();
  }
});

test("legacy rejection resumes later delivery only after active outline repair", async () => {
  let postCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/ops") return jsonResponse({ ok: true });
    postCount += 1;
    return postCount === 1
      ? jsonResponse({ detail: "bad op" }, 400)
      : jsonResponse({ ok: true });
  }));
  let releaseRepair!: () => void;
  const repairGate = new Promise<void>((done) => { releaseRepair = done; });
  const session = acquireOutlineSession("Legacy repair target", []);
  const load = vi.fn(async () => {
    await repairGate;
    return [];
  });
  const removeLoader = session.setAuthoritativeLoader(load);
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return <div data-testid="legacy-resync">{sync.resyncSeq}</div>;
  }

  const view = render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  const rejected = sync.enqueue(
    [{ op: "delete", uid: "bad" }], ["page", "Legacy repair target"],
  );
  session.applyLocal(rejected, [{ op: "delete", uid: "bad" }]);
  await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
  await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

  const later = sync.enqueue([{ op: "delete", uid: "later" }]);
  await Promise.resolve();
  expect(postCount).toBe(1);
  expect(screen.getByTestId("legacy-resync")).toHaveTextContent("0");

  releaseRepair();
  await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  expect(postCount).toBe(2);
  await vi.waitFor(() => {
    expect(screen.getByTestId("legacy-resync")).toHaveTextContent("1");
  });

  view.unmount();
  removeLoader();
  session.release();
});

test("legacy repair waits for a forced read after an existing stale automatic read", async () => {
  let postCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/ops") return jsonResponse({ ok: true });
    postCount += 1;
    return postCount === 1
      ? jsonResponse({ detail: "bad op" }, 400)
      : jsonResponse({ ok: true });
  }));
  const stale = (() => {
    let resolve!: (blocks: ReturnType<typeof block>[]) => void;
    const promise = new Promise<ReturnType<typeof block>[]>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  })();
  const forced = (() => {
    let resolve!: (blocks: ReturnType<typeof block>[]) => void;
    const promise = new Promise<ReturnType<typeof block>[]>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  })();
  const session = acquireOutlineSession(
    "Legacy forced target", [block("u1", "optimistic")],
  );
  const loadForced = vi.fn(() => forced.promise);
  const removeLoader = session.setAuthoritativeLoader(loadForced);
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return <div data-testid="forced-repair">{
      sync.problem?.kind === "legacy-rejected" ? sync.problem.repair : "none"
    }</div>;
  }
  const view = render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  let later: ReturnType<Sync["enqueue"]> | undefined;
  try {
    await act(async () => { lastWs().open(); });
    const rejected = sync.enqueue(
      [{ op: "delete", uid: "bad" }], ["page", "Legacy forced target"],
    );
    session.applyLocal(rejected, []);
    const existing = session.requestAuthoritative(() => stale.promise);
    await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
    later = sync.enqueue(
      [{ op: "delete", uid: "later" }], ["page", "Legacy forced target"],
    );
    session.applyLocal(later, []);

    stale.resolve([block("u1", "stale pre-rejection")]);
    await existing;
    await vi.waitFor(() => expect(loadForced).toHaveBeenCalledTimes(1));
    expect(postCount).toBe(1);
    expect(screen.getByTestId("forced-repair")).toHaveTextContent("running");

    forced.resolve([block("u1", "post-rejection authoritative")]);
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
    expect(postCount).toBe(2);
  } finally {
    stale.resolve([block("u1", "cleanup stale")]);
    forced.resolve([block("u1", "cleanup forced")]);
    view.unmount();
    removeLoader();
    session.release();
  }
});

test("legacy repair enrolls a session opened before queue resume", async () => {
  let postCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/ops") return jsonResponse({ ok: true });
    postCount += 1;
    return postCount === 1
      ? jsonResponse({ detail: "bad op" }, 400)
      : jsonResponse({ ok: true });
  }));
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((done) => { releaseFirst = done; });
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((done) => { releaseSecond = done; });
  const first = acquireOutlineSession("Dynamic repair first", []);
  const firstLoad = vi.fn(async () => {
    await firstGate;
    return [];
  });
  const removeFirstLoader = first.setAuthoritativeLoader(firstLoad);
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return null;
  }
  const view = render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  let second: ReturnType<typeof acquireOutlineSession> | undefined;
  let removeSecondLoader: (() => void) | undefined;
  try {
    await act(async () => { lastWs().open(); });
    const rejected = sync.enqueue(
      [{ op: "delete", uid: "bad" }], ["page", "Dynamic repair first"],
    );
    first.applyLocal(rejected, []);
    await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
    await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledTimes(1));

    second = acquireOutlineSession("Dynamic repair second", []);
    const secondLoad = vi.fn(async () => {
      await secondGate;
      return [];
    });
    removeSecondLoader = second.setAuthoritativeLoader(secondLoad);
    const later = sync.enqueue([{ op: "delete", uid: "later" }]);
    expect(postCount).toBe(1);

    releaseFirst();
    await vi.waitFor(() => expect(secondLoad).toHaveBeenCalledTimes(1));
    expect(postCount).toBe(1);

    releaseSecond();
    await expect(later.delivered).resolves.toEqual({ status: "delivered" });
    expect(postCount).toBe(2);
  } finally {
    releaseFirst();
    releaseSecond();
    view.unmount();
    removeSecondLoader?.();
    second?.release();
    removeFirstLoader();
    first.release();
  }
});

test("the Sync enqueue boundary registers a page ticket before its session opens", async () => {
  let releasePost!: () => void;
  const postGate = new Promise<void>((done) => { releasePost = done; });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/ops") await postGate;
    return jsonResponse({ ok: true });
  }));
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return null;
  }
  const view = render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  const targetTitle = "Same-page fallback target";
  const otherTitle = "Unrelated fallback title";
  let target: ReturnType<typeof acquireOutlineSession> | undefined;
  let other: ReturnType<typeof acquireOutlineSession> | undefined;
  let removeLoader: (() => void) | undefined;
  try {
    await act(async () => { lastWs().open(); });
    const ticket = sync.enqueue(
      [{ op: "move", uid: "u1", parent_uid: null, order_idx: 0 }],
      ["page", targetTitle],
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/ops", expect.anything(),
    ));
    target = acquireOutlineSession(targetTitle, [block("u1", "opened")]);
    const load = vi.fn(async () => [block("u1", "post-delivery")]);
    removeLoader = target.setAuthoritativeLoader(load);
    other = acquireOutlineSession(otherTitle, [block("u2", "other old")]);
    const targetToken = target.beginAuthoritativeRead("parent");
    const otherToken = other.beginAuthoritativeRead("parent");
    target.receiveAuthoritative(targetToken, [block("u1", "pre-POST")]);
    other.receiveAuthoritative(otherToken, [block("u2", "other fresh")]);

    expect(target.getSnapshot().blocks[0].text).toBe("opened");
    expect(other.getSnapshot().blocks[0].text).toBe("other fresh");

    releasePost();
    await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
    await vi.waitFor(() => {
      expect(target!.getSnapshot().blocks[0].text).toBe("post-delivery");
    });
  } finally {
    releasePost();
    removeLoader?.();
    target?.release();
    other?.release();
    view.unmount();
  }
});

test("failed legacy outline repair stays visible and Retry releases delivery", async () => {
  let postCount = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/api/ops") return jsonResponse({ ok: true });
    postCount += 1;
    return postCount === 1
      ? jsonResponse({ detail: "bad op" }, 400)
      : jsonResponse({ ok: true });
  }));
  const session = acquireOutlineSession("Retry legacy repair", []);
  let loadCount = 0;
  const removeLoader = session.setAuthoritativeLoader(async () => {
    loadCount += 1;
    if (loadCount === 1) throw new Error("page read failed");
    return [];
  });
  let sync!: Sync;
  function Grab() {
    sync = useSync();
    return <div data-testid="legacy-problem">{
      sync.problem?.kind === "legacy-rejected" ? sync.problem.repair : "none"
    }</div>;
  }

  const view = render(<SyncProvider replica={null}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  const rejected = sync.enqueue([{ op: "delete", uid: "bad" }]);
  await expect(rejected.delivered).resolves.toMatchObject({ status: "failed" });
  await vi.waitFor(() => {
    expect(screen.getByTestId("legacy-problem")).toHaveTextContent("failed");
  });

  const later = sync.enqueue([{ op: "delete", uid: "later" }]);
  expect(postCount).toBe(1);
  await act(async () => { await sync.retryProblem(); });
  await expect(later.delivered).resolves.toEqual({ status: "delivered" });
  expect(loadCount).toBe(2);
  expect(postCount).toBe(2);

  view.unmount();
  removeLoader();
  session.release();
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

test("rejected batch repair finishes before resync and later delivery", async () => {
  let releaseSnapshot!: () => void;
  let snapshotHasStarted = false;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      const body = JSON.parse(String(init?.body)) as { batch_id: string };
      posts.push(body.batch_id);
      return body.batch_id === "bad-batch"
        ? jsonResponse({ detail: "bad op" }, 400)
        : jsonResponse({ ok: true });
    }
    if (url === "/api/sync/snapshot") {
      snapshotHasStarted = true;
      await snapshotGate;
      return jsonResponse(SNAPSHOT);
    }
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));

  const replica = fakeReplicaForProvider();
  const rows: Array<{ id: number; batch_id: string; ops: BlockOp[];
                     poisoned: boolean }> = [];
  let nextId = 1;
  const trace: string[] = [];
  replica.init = async () => ({
    ok: true, empty: false, cursor: 5, schemaMismatch: false,
    pendingBatches: [],
  });
  replica.enqueue = async (ops) => {
    const id = nextId++;
    rows.push({ id, batch_id: id === 1 ? "bad-batch" : "good-batch",
                ops, poisoned: false });
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.nextBatch = async () => rows.find((row) => !row.poisoned) ?? null;
  replica.markPoisoned = async (id) => {
    trace.push("mark poison");
    rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.pendingCount = async () => rows.filter((row) => !row.poisoned).length;
  replica.pendingBatches = async () => [...rows];
  replica.prepareRecovery = async () => {
    trace.push("prepare repair");
    return { token: "poison-lease", batches: [...rows] };
  };
  replica.commitRecovery = async () => { trace.push("commit repair"); };
  replica.deleteBatch = async (id) => {
    trace.push(`delete ${id}`);
    rows.splice(rows.findIndex((row) => row.id === id), 1);
    return { pending: rows.filter((row) => !row.poisoned).length };
  };

  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  const baselineResync = sync.resyncSeq;
  await act(async () => {
    await sync.enqueue([{ op: "delete", uid: "bad" }]).settled;
    await sync.enqueue([{ op: "delete", uid: "good" }]).settled;
    await Promise.resolve();
  });
  await vi.waitFor(() => { expect(snapshotHasStarted).toBe(true); });

  expect(posts).toEqual(["bad-batch"]);
  expect(trace).toEqual(["mark poison", "prepare repair"]);
  expect(sync.resyncSeq).toBe(baselineResync);

  await act(async () => { releaseSnapshot(); await snapshotGate; });
  await vi.waitFor(() => { expect(posts).toEqual(["bad-batch", "good-batch"]); });
  expect(trace).toEqual([
    "mark poison", "prepare repair", "commit repair", "delete 1", "delete 2",
  ]);
  expect(sync.resyncSeq).toBe(baselineResync + 1);
});

test("startup repairs durable poison before posting a later batch", async () => {
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let snapshotStarted = false;
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/sync/snapshot") {
      snapshotStarted = true;
      await snapshotGate;
      return jsonResponse(SNAPSHOT);
    }
    if (url === "/api/ops") {
      posts.push((JSON.parse(String(init?.body)) as { batch_id: string }).batch_id);
      return jsonResponse({ ok: true });
    }
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));

  const rejectedOp = { op: "delete", uid: "rejected" } as const;
  const goodOp = { op: "delete", uid: "good" } as const;
  const rows = [
    { id: 1, batch_id: "old-poison", ops: [rejectedOp], poisoned: true },
    { id: 2, batch_id: "later-good", ops: [goodOp], poisoned: false },
  ];
  const replica = fakeReplicaForProvider();
  replica.init = async () => ({
    ok: true, empty: false, cursor: 5, schemaMismatch: false,
    pendingBatches: [...rows],
  });
  replica.poisonedBatches = async () => [{
    rowId: 1, batchId: "old-poison", ops: [rejectedOp], status: 400,
    message: "request failed: 400 /api/ops",
  }];
  replica.pendingCount = async () => rows.filter((row) => !row.poisoned).length;
  replica.pendingBatches = async () => [...rows];
  replica.nextBatch = async () => rows.find((row) => !row.poisoned) ?? null;
  replica.prepareRecovery = async () => ({ token: "startup-poison", batches: [...rows] });
  replica.commitRecovery = async () => undefined;
  replica.deleteBatch = async (id) => {
    rows.splice(rows.findIndex((row) => row.id === id), 1);
    return { pending: rows.filter((row) => !row.poisoned).length };
  };

  render(<SyncProvider replica={replica}><div /></SyncProvider>);
  await act(async () => { lastWs().open(); await Promise.resolve(); });
  await vi.waitFor(() => { expect(snapshotStarted).toBe(true); });
  expect(posts).toEqual([]);

  await act(async () => { releaseSnapshot(); await snapshotGate; });
  await vi.waitFor(() => { expect(posts).toEqual(["later-good"]); });
  expect(rows).toEqual([]);
});

test("reload retries only the durable mark and surfaces failure before startup",
async () => {
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      const batchId = (JSON.parse(String(init?.body)) as { batch_id: string }).batch_id;
      posts.push(batchId);
      return batchId === "bad-batch"
        ? jsonResponse({ detail: "bad op" }, 400)
        : jsonResponse({ ok: true });
    }
    if (url === "/api/sync/snapshot") return jsonResponse(SNAPSHOT);
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));

  const replica = fakeReplicaForProvider();
  const rows: Array<{ id: number; batch_id: string; ops: BlockOp[];
                     poisoned: boolean }> = [];
  let nextId = 1;
  let markAttempts = 0;
  let poisonDiscoveryCalls = 0;
  let initCalls = 0;
  replica.enqueue = async (ops) => {
    const id = nextId++;
    rows.push({ id, batch_id: id === 1 ? "bad-batch" : "later-good",
                ops, poisoned: false });
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.nextBatch = async () => rows.find((row) => !row.poisoned) ?? null;
  replica.pendingCount = async () => rows.filter((row) => !row.poisoned).length;
  replica.pendingBatches = async () => [...rows];
  replica.markPoisoned = async (id) => {
    markAttempts += 1;
    if (markAttempts <= 2) throw new Error(`mark unavailable ${markAttempts}`);
    rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.poisonedBatches = async () => {
    poisonDiscoveryCalls += 1;
    return rows.filter((row) => row.poisoned).map((row) => ({
      rowId: row.id, batchId: row.batch_id, ops: row.ops,
      status: 400, message: "request failed: 400 /api/ops",
    }));
  };
  replica.init = async () => {
    initCalls += 1;
    return { ok: true, empty: false, cursor: 5, schemaMismatch: false,
             pendingBatches: [...rows] };
  };
  replica.prepareRecovery = async () => ({ token: "reload-poison", batches: [...rows] });
  replica.commitRecovery = async () => undefined;
  replica.deleteBatch = async (id) => {
    rows.splice(rows.findIndex((row) => row.id === id), 1);
    return { pending: rows.filter((row) => !row.poisoned).length };
  };

  const firstPage = createOpQueue(replica, () => undefined);
  firstPage.enqueue([{ op: "delete", uid: "bad" }]);
  firstPage.enqueue([{ op: "delete", uid: "good" }]);
  await firstPage.settled();
  await firstPage.drain();
  firstPage.dispose();
  expect(posts).toEqual(["bad-batch"]);
  expect(markAttempts).toBe(1);

  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  await vi.waitFor(() => { expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "mark-failed",
  }); });

  expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "mark-failed",
    event: { batchId: "bad-batch" }, error: "mark unavailable 2",
  });
  expect(posts).toEqual(["bad-batch"]); // reload never redelivered either row
  expect(markAttempts).toBe(2); // startup performed mark-only retry
  expect(poisonDiscoveryCalls).toBe(0);
  expect(initCalls).toBe(0);

  await act(async () => { await sync.retryProblem(); });
  await vi.waitFor(() => { expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "repaired",
  }); });

  expect(markAttempts).toBe(3);
  expect(posts.filter((batchId) => batchId === "bad-batch")).toHaveLength(1);
  expect(poisonDiscoveryCalls).toBe(1);
  expect(initCalls).toBe(1);
});

test("startup repairs returned marks even when poison discovery fails", async () => {
  const event = {
    rowId: 1, batchId: "bad-batch",
    ops: [{ op: "delete", uid: "bad" } as const],
    status: 400, message: "request failed: 400 /api/ops",
  };
  localStorage.setItem("pkm.poison-mark-intents.v1", JSON.stringify({
    version: 1, intents: [event],
  }));
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let snapshotStarted = false;
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/sync/snapshot") {
      snapshotStarted = true;
      await snapshotGate;
      return jsonResponse(SNAPSHOT);
    }
    if (url === "/api/ops") {
      posts.push((JSON.parse(String(init?.body)) as { batch_id: string }).batch_id);
      return jsonResponse({ ok: true });
    }
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));
  const rows = [
    { id: 1, batch_id: "bad-batch", ops: [...event.ops], poisoned: false },
    { id: 2, batch_id: "later-good",
      ops: [{ op: "delete", uid: "good" } as const], poisoned: false },
  ];
  const replica = fakeReplicaForProvider();
  let discoveryCalls = 0;
  let initCalls = 0;
  replica.markPoisoned = async (id) => {
    rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.poisonedBatches = async () => {
    discoveryCalls += 1;
    throw new Error("poison discovery unavailable");
  };
  replica.pendingCount = async () => rows.filter((row) => !row.poisoned).length;
  replica.pendingBatches = async () => [...rows];
  replica.nextBatch = async () => rows.find((row) => !row.poisoned) ?? null;
  replica.init = async () => {
    initCalls += 1;
    return { ok: true, empty: false, cursor: 5, schemaMismatch: false,
             pendingBatches: [...rows] };
  };
  replica.prepareRecovery = async () => ({ token: "returned-mark", batches: [...rows] });
  replica.commitRecovery = async () => undefined;
  replica.deleteBatch = async (id) => {
    rows.splice(rows.findIndex((row) => row.id === id), 1);
    return { pending: rows.filter((row) => !row.poisoned).length };
  };

  render(<SyncProvider replica={replica}><div /></SyncProvider>);
  await act(async () => { lastWs().open(); await Promise.resolve(); });
  await vi.waitFor(() => { expect(discoveryCalls).toBe(1); });

  expect(snapshotStarted).toBe(true);
  expect(initCalls).toBe(0);
  expect(posts).toEqual([]);

  await act(async () => { releaseSnapshot(); await snapshotGate; });
});

test("startup discovery failure without fallback is visible and retryable",
async () => {
  const replica = fakeReplicaForProvider();
  let discoveryCalls = 0;
  let initCalls = 0;
  replica.poisonedBatches = async () => {
    discoveryCalls += 1;
    if (discoveryCalls === 1) throw new Error("poison discovery unavailable");
    return [];
  };
  replica.init = async () => {
    initCalls += 1;
    return { ok: true, empty: false, cursor: 5, schemaMismatch: false,
             pendingBatches: [] };
  };
  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); await Promise.resolve(); });
  await vi.waitFor(() => { expect(discoveryCalls).toBe(1); });

  expect(sync.problem).toMatchObject({
    kind: "poison-discovery", error: "poison discovery unavailable",
  });
  expect(initCalls).toBe(0);

  await act(async () => { await sync.retryProblem(); });
  expect(discoveryCalls).toBe(2);
  expect(initCalls).toBe(1);
});

test("failed poison repair stays visible and Retry succeeds without reapplying it", async () => {
  let snapshotCalls = 0;
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      const batchId = (JSON.parse(String(init?.body)) as { batch_id: string }).batch_id;
      posts.push(batchId);
      return batchId === "bad-batch"
        ? jsonResponse({ detail: "bad op" }, 400)
        : jsonResponse({ ok: true });
    }
    if (url === "/api/sync/snapshot") {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? jsonResponse({ detail: "snapshot unavailable" }, 503)
        : jsonResponse(SNAPSHOT);
    }
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));

  const replica = fakeReplicaForProvider();
  const rows: Array<{ id: number; batch_id: string; ops: BlockOp[];
                     poisoned: boolean }> = [];
  let nextId = 1;
  replica.init = async () => ({
    ok: true, empty: false, cursor: 5, schemaMismatch: false,
    pendingBatches: [],
  });
  replica.enqueue = async (ops) => {
    const id = nextId++;
    rows.push({ id, batch_id: id === 1 ? "bad-batch" : "good-batch",
                ops, poisoned: false });
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.nextBatch = async () => rows.find((row) => !row.poisoned) ?? null;
  replica.markPoisoned = async (id) => {
    rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.pendingCount = async () => rows.filter((row) => !row.poisoned).length;
  replica.pendingBatches = async () => [...rows];
  replica.prepareRecovery = async () => ({ token: `lease-${snapshotCalls}`, batches: [...rows] });
  replica.commitRecovery = async () => undefined;
  replica.abortRecovery = async () => undefined;
  replica.deleteBatch = async (id) => {
    rows.splice(rows.findIndex((row) => row.id === id), 1);
    return { pending: rows.filter((row) => !row.poisoned).length };
  };

  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  await act(async () => {
    await sync.enqueue([{ op: "delete", uid: "bad" }]).settled;
    await sync.enqueue([{ op: "delete", uid: "good" }]).settled;
  });
  await vi.waitFor(() => { expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "failed",
  }); });
  expect(sync.status).toBe("connected");
  expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "failed",
    event: { batchId: "bad-batch", status: 400 },
    error: "request failed: 503 /api/sync/snapshot",
  });
  expect(posts).toEqual(["bad-batch"]);

  const controls = sync as unknown as {
    retryProblem(): Promise<void>;
    dismissProblem(): void;
  };
  expect(controls.retryProblem).toBeTypeOf("function");
  expect(controls.dismissProblem).toBeTypeOf("function");
  act(() => { controls.dismissProblem(); });
  expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "failed",
  });

  await act(async () => { await controls.retryProblem(); });
  await vi.waitFor(() => { expect(posts).toEqual(["bad-batch", "good-batch"]); });
  expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "repaired",
  });
  expect(snapshotCalls).toBe(2);

  act(() => { controls.dismissProblem(); });
  expect(sync.problem).toBeUndefined();
  await act(async () => { await Promise.resolve(); });
  expect(posts).toEqual(["bad-batch", "good-batch"]);
});

test("applySync reads the freshest problem for same-tick dispatches: a dismiss " +
"racing a new repair-started must not erase it", async () => {
  let snapshotCalls = 0;
  const posts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL,
                                      init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/ops") {
      const batchId = (JSON.parse(String(init?.body)) as { batch_id: string }).batch_id;
      posts.push(batchId);
      return batchId === "bad-batch" || batchId === "bad-batch-2"
        ? jsonResponse({ detail: "bad op" }, 400)
        : jsonResponse({ ok: true });
    }
    if (url === "/api/sync/snapshot") {
      snapshotCalls += 1;
      return snapshotCalls === 1
        ? jsonResponse({ detail: "snapshot unavailable" }, 503)
        : jsonResponse(SNAPSHOT);
    }
    if (url.startsWith("/api/sync/changes")) return jsonResponse(EMPTY_FEED);
    return jsonResponse({ detail: "not found" }, 404);
  }));

  const replica = fakeReplicaForProvider();
  const rows: Array<{ id: number; batch_id: string; ops: BlockOp[];
                     poisoned: boolean }> = [];
  let nextId = 1;
  replica.init = async () => ({
    ok: true, empty: false, cursor: 5, schemaMismatch: false,
    pendingBatches: [],
  });
  replica.enqueue = async (ops) => {
    const id = nextId++;
    const batchId = id === 1 ? "bad-batch" : id === 2 ? "good-batch" : "bad-batch-2";
    rows.push({ id, batch_id: batchId, ops, poisoned: false });
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.nextBatch = async () => rows.find((row) => !row.poisoned) ?? null;
  replica.markPoisoned = async (id) => {
    rows.find((row) => row.id === id)!.poisoned = true;
    return { pending: rows.filter((row) => !row.poisoned).length };
  };
  replica.pendingCount = async () => rows.filter((row) => !row.poisoned).length;
  replica.pendingBatches = async () => [...rows];
  let prepareCalls = 0;
  let reachedThirdRebase!: () => void;
  const thirdRebase = new Promise<void>((resolve) => { reachedThirdRebase = resolve; });
  replica.prepareRecovery = async () => {
    prepareCalls += 1;
    if (prepareCalls < 3) return { token: `lease-${prepareCalls}`, batches: [...rows] };
    // The third repair (bad-batch-2's) is left permanently mid-flight so its
    // "running" problem state cannot itself progress to repaired/failed
    // before the same-tick dismiss below is dispatched.
    reachedThirdRebase();
    return new Promise<never>(() => undefined);
  };
  replica.commitRecovery = async () => undefined;
  replica.abortRecovery = async () => undefined;
  replica.deleteBatch = async (id) => {
    rows.splice(rows.findIndex((row) => row.id === id), 1);
    return { pending: rows.filter((row) => !row.poisoned).length };
  };

  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { lastWs().open(); });
  await act(async () => {
    await sync.enqueue([{ op: "delete", uid: "bad" }]).settled;
    await sync.enqueue([{ op: "delete", uid: "good" }]).settled;
  });
  await vi.waitFor(() => { expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "failed",
  }); });

  const controls = sync as unknown as { retryProblem(): Promise<void> };
  await act(async () => { await controls.retryProblem(); });
  await vi.waitFor(() => { expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "repaired",
  }); });
  expect(posts).toEqual(["bad-batch", "good-batch"]);

  // Same-tick race: a new batch is rejected (repair-started fires, replacing
  // the still-visible "repaired" problem) and, before React can re-render,
  // dismissProblem() is invoked. dismissProblem must judge the freshest
  // problem (now "running"), not the stale "repaired" snapshot from before
  // this tick -- otherwise it wrongly dismisses the live repair.
  await act(async () => {
    sync.enqueue([{ op: "delete", uid: "bad2" }]);
    await thirdRebase;
    sync.dismissProblem();
  });

  expect(sync.problem).toMatchObject({
    kind: "rejected-batch", repair: "running", event: { batchId: "bad-batch-2" },
  });
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
  await act(async () => {
    const write = sync.enqueue([{ op: "delete", uid: "u1" }]);
    await write.settled;
  });
  expect(sync.pending).toBe(3);
  expect(sync.readOnlyReason).toBeUndefined();
});

test("cold start offline: a hydrated replica reaches ready and bumps resync", async () => {
  // no socket ever opens; init is local, and views that errored while the
  // replica was starting must be told to refetch (through the shim)
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
  const replica = fakeReplicaForProvider();
  replica.init = async () => ({ ok: true, empty: false, cursor: 5,
                                schemaMismatch: false, pendingBatches: [] });
  function Grab() {
    const sync = useSync();
    return <div data-testid="s">{sync.replicaMode}:{sync.resyncSeq}:{String(sync.canEdit)}</div>;
  }
  render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByTestId("s").textContent).toBe("ready:1:true");
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

test("an injected replica remains caller-owned on provider unmount", async () => {
  const replica = fakeReplicaForProvider();
  const dispose = vi.spyOn(replica, "dispose");
  const { unmount } = render(
    <SyncProvider replica={replica}><div /></SyncProvider>);

  unmount();
  await Promise.resolve();

  expect(dispose).not.toHaveBeenCalled();
});

test("the internally created worker closes its database before one termination", async () => {
  const events: string[] = [];
  class FakeWorker {
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: ((ev: { error?: unknown; message?: string }) => void) | null = null;
    onmessageerror: ((ev: { data?: unknown }) => void) | null = null;

    postMessage(message: unknown): void {
      const req = message as { id: number; method: string };
      if (req.method === "close") events.push("close-db");
      const result = req.method === "init"
        ? { ok: false, empty: true, cursor: 0, schemaMismatch: false,
            pendingBatches: [] }
        : req.method === "pendingCount" ? 0 : null;
      queueMicrotask(() => this.onmessage?.({ data: { id: req.id, result } }));
    }

    terminate(): void { events.push("terminate-worker"); }
  }
  vi.stubGlobal("Worker", FakeWorker);
  const { unmount } = render(
    <StrictMode><SyncProvider><div /></SyncProvider></StrictMode>);
  await act(async () => { await Promise.resolve(); });
  expect(events).toEqual([]);

  unmount();
  await act(async () => { await Promise.resolve(); });

  expect(events).toEqual(["close-db", "terminate-worker"]);
});

test("StrictMode effect replay keeps the queue live", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  let sync!: Sync;
  function Grab() { sync = useSync(); return null; }
  render(
    <StrictMode>
      <SyncProvider replica={null}><Grab /></SyncProvider>
    </StrictMode>);
  act(() => lastWs().open());

  const write = sync.enqueue([{ op: "delete", uid: "u1" }]);
  await expect(write.settled).resolves.toMatchObject({ status: "persisted" });
  await act(async () => { await Promise.resolve(); });

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a blocked reconnect drain does not pull the feed or bump resync", async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/ops") {
        return new Response(JSON.stringify({ detail: "busy" }), { status: 503 });
      }
      return new Response(JSON.stringify({}), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }));
    let sync!: Sync;
    function Grab() {
      sync = useSync();
      return <div data-testid="blocked-status">{sync.resyncSeq}</div>;
    }
    render(<SyncProvider replica={null}><Grab /></SyncProvider>);
    act(() => lastWs().open());
    act(() => lastWs().drop());
    act(() => { sync.enqueue([{ op: "delete", uid: "u1" }]); });
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => { lastWs().open(); await Promise.resolve(); });

    expect(screen.getByTestId("blocked-status").textContent).toBe("0");
  } finally {
    vi.useRealTimers();
  }
});

test("automatic retry completes reconnect feed pull and resync exactly once", async () => {
  vi.useFakeTimers();
  try {
    let opsCalls = 0;
    let changeCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ops") {
        opsCalls += 1;
        return opsCalls === 1
          ? jsonResponse({ detail: "busy" }, 503)
          : jsonResponse({ ok: true });
      }
      if (url.startsWith("/api/sync/changes")) {
        changeCalls += 1;
        return jsonResponse(EMPTY_FEED);
      }
      return jsonResponse({ ok: true });
    }));
    const replica = fakeReplicaForProvider();
    const rows: Array<{ id: number; batch_id: string; ops: BlockOp[];
                       poisoned: boolean }> = [];
    replica.init = async () => ({
      ok: true, empty: false, cursor: 5, schemaMismatch: false,
      pendingBatches: [],
    });
    replica.enqueue = async (ops) => {
      rows.push({ id: 1, batch_id: "retry-me", ops, poisoned: false });
      return { pending: rows.length };
    };
    replica.nextBatch = async () => rows[0] ?? null;
    replica.deleteBatch = async () => {
      rows.pop();
      return { pending: rows.length };
    };
    replica.pendingCount = async () => rows.length;
    let sync!: Sync;
    function Grab() {
      sync = useSync();
      return <div data-testid="retry-status">{sync.resyncSeq}</div>;
    }
    render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
    await act(async () => { lastWs().open(); });
    const baselineResync = sync.resyncSeq;
    const baselineChanges = changeCalls;
    act(() => lastWs().drop());
    await act(async () => {
      await sync.enqueue([{ op: "delete", uid: "u1" }]).settled;
    });
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => { lastWs().open(); await Promise.resolve(); });
    expect(sync.resyncSeq).toBe(baselineResync);

    await act(async () => { await vi.advanceTimersByTimeAsync(250); });

    expect(rows).toEqual([]);
    expect(changeCalls).toBe(baselineChanges + 1);
    expect(sync.resyncSeq).toBe(baselineResync + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(changeCalls).toBe(baselineChanges + 1);
    expect(sync.resyncSeq).toBe(baselineResync + 1);
  } finally {
    vi.useRealTimers();
  }
});

test("overlapping reconnects share one completion and leave no stale intent", async () => {
  vi.useFakeTimers();
  try {
    let changeCalls = 0;
    let holdNextFeed = false;
    let releaseFeed!: () => void;
    let feedStarted!: () => void;
    const feedGate = new Promise<void>((resolve) => { releaseFeed = resolve; });
    const started = new Promise<void>((resolve) => { feedStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/sync/changes")) {
        changeCalls += 1;
        if (holdNextFeed) {
          holdNextFeed = false;
          feedStarted();
          await feedGate;
        }
        return jsonResponse(EMPTY_FEED);
      }
      return jsonResponse({ ok: true });
    }));
    const replica = fakeReplicaForProvider();
    replica.init = async () => ({
      ok: true, empty: false, cursor: 5, schemaMismatch: false,
      pendingBatches: [],
    });
    let sync!: Sync;
    function Grab() { sync = useSync(); return null; }
    render(<SyncProvider replica={replica}><Grab /></SyncProvider>);
    await act(async () => { lastWs().open(); });
    const baselineChanges = changeCalls;
    const baselineResync = sync.resyncSeq;

    holdNextFeed = true;
    act(() => lastWs().drop());
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => { lastWs().open(); await started; });

    act(() => lastWs().drop());
    act(() => { vi.advanceTimersByTime(2_000); });
    await act(async () => { lastWs().open(); await Promise.resolve(); });
    expect(changeCalls).toBe(baselineChanges + 1);
    expect(sync.resyncSeq).toBe(baselineResync);

    await act(async () => { releaseFeed(); await feedGate; });
    expect(changeCalls).toBe(baselineChanges + 1);
    expect(sync.resyncSeq).toBe(baselineResync + 1);

    await act(async () => {
      await sync.enqueue([{ op: "delete", uid: "unrelated" }]).settled;
      await Promise.resolve();
    });
    expect(changeCalls).toBe(baselineChanges + 1);
    expect(sync.resyncSeq).toBe(baselineResync + 1);
  } finally {
    vi.useRealTimers();
  }
});

test("provider cleanup disposes the queue and cancels its retry timer", async () => {
  vi.useFakeTimers();
  try {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ detail: "busy" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    let sync!: Sync;
    function Grab() { sync = useSync(); return null; }
    const { unmount } = render(
      <SyncProvider replica={null}><Grab /></SyncProvider>);
    act(() => lastWs().open());
    act(() => { sync.enqueue([{ op: "delete", uid: "u1" }]); });
    await act(async () => { await Promise.resolve(); });
    unmount();

    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
