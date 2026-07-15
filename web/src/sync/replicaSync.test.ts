import { expect, test, vi } from "vitest";
import type { ApplyResult, Changes, Snapshot } from "../replica/apply";
import type { PendingBatch, Replica, ReplicaInit } from "../replica/client";
import { createReplicaSync, type ReplicaState } from "./replicaSync";

const SNAP: Snapshot = {
  generation: "gen-1", seq: 5, pages: [], blocks: [], sidebar: [],
};

const feed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", next_since: 5, latest_seq: 5,
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

function fakeReplica(over: Partial<Replica> = {},
                     init: Partial<ReplicaInit> = {}): Replica & { calls: string[] } {
  const calls: string[] = [];
  const rec = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    calls,
    init: () => rec("init", { ok: true, empty: false, cursor: 5,
                              schemaMismatch: false, pendingBatches: [],
                              ...init } as ReplicaInit),
    applySnapshot: () => rec("applySnapshot", undefined),
    applyChanges: (f: Changes) =>
      rec<ApplyResult>("applyChanges", { status: "applied", cursor: f.next_since }),
    enqueue: () => rec("enqueue", { pending: 0 }),
    nextBatch: () => rec<PendingBatch | null>("nextBatch", null),
    deleteBatch: () => rec("deleteBatch", { pending: 0 }),
    markPoisoned: () => rec("markPoisoned", { pending: 0 }),
    pendingCount: () => rec("pendingCount", 0),
    pendingBatches: () => rec<PendingBatch[]>("pendingBatches", []),
    localApi: () => rec("localApi", { handled: false as const }),
    prepareRecovery: () => rec("prepareRecovery", {
      token: "lease-1", batches: init.pendingBatches ?? [],
    }),
    commitRecovery: () => rec("commitRecovery", undefined),
    abortRecovery: () => rec("abortRecovery", undefined),
    reset: () => rec("reset", undefined),
    dispose: () => rec("dispose", undefined),
    ...over,
  };
}

function collector() {
  const states: ReplicaState[] = [];
  return { states, onState: (s: ReplicaState) => { states.push(s); } };
}

test("start on an empty replica bootstraps from the snapshot then is ready", async () => {
  const replica = fakeReplica({}, { empty: true, cursor: 0 });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/sync/snapshot") return SNAP;
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(fetchJson).toHaveBeenCalledWith("/api/sync/snapshot");
  expect(replica.calls).toContain("applySnapshot");
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("start on a warm replica skips the snapshot and catches up the feed", async () => {
  const replica = fakeReplica();
  const fetchJson = vi.fn(async () => feed({ next_since: 9, latest_seq: 9 }));
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(fetchJson).toHaveBeenCalledWith("/api/sync/changes?since=5");
  expect(fetchJson).not.toHaveBeenCalledWith("/api/sync/snapshot");
});

test("a feed invalidated by pending-batch changes is refetched from the same cursor", async () => {
  const applyChanges = vi.fn()
    .mockResolvedValueOnce({ status: "pending-changed" })
    .mockResolvedValueOnce({ status: "applied", cursor: 6 });
  const pendingBatches = vi.fn()
    .mockResolvedValueOnce([{
      id: 1, batch_id: "batch-1", ops: [], poisoned: false,
    }])
    .mockResolvedValueOnce([]);
  const replica = fakeReplica({ applyChanges, pendingBatches });
  const stale = feed({ next_since: 6, latest_seq: 6 });
  const fetchJson = vi.fn(async (_path: string) => stale);
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });

  await sync.start();

  expect(fetchJson).toHaveBeenCalledTimes(2);
  expect(fetchJson.mock.calls.map(([path]) => path))
    .toEqual(["/api/sync/changes?since=5", "/api/sync/changes?since=5"]);
  expect(applyChanges.mock.calls).toEqual([
    [stale, [1]],
    [stale, []],
  ]);
});

test("no-replica init reports mode and never fetches", async () => {
  const replica = fakeReplica({}, { ok: false });
  const fetchJson = vi.fn();
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(states.at(-1)).toEqual({ mode: "no-replica" });
  expect(fetchJson).not.toHaveBeenCalled();
});

test("a hydrated replica reaches ready with the network down (cold start offline)", async () => {
  // start() must not need the socket: a cold start offline serves the app
  // shell from the service worker and content from the replica
  const replica = fakeReplica();
  const fetchJson = vi.fn(async () => { throw new TypeError("offline"); });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start(); // catch-up pull fails quietly; readiness is local
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("concurrent start calls share one initialization", async () => {
  // mount and the first socket connect both call start(): the bootstrap
  // must run exactly once
  const replica = fakeReplica({}, { empty: true, cursor: 0 });
  const fetchJson = vi.fn(async (path: string) =>
    path === "/api/sync/snapshot" ? SNAP : feed());
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await Promise.all([sync.start(), sync.start()]);
  expect(replica.calls.filter((c) => c === "init")).toHaveLength(1);
  expect(replica.calls.filter((c) => c === "applySnapshot")).toHaveLength(1);
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("a failed empty-replica bootstrap (offline first visit) retries on next start", async () => {
  const replica = fakeReplica({}, { empty: true, cursor: 0 });
  const fetchJson = vi.fn()
    .mockRejectedValueOnce(new TypeError("offline"))
    .mockImplementation(async (path: string) =>
      path === "/api/sync/snapshot" ? SNAP : feed());
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await expect(sync.start()).rejects.toThrow("offline");
  await sync.start(); // reconnect: succeeds this time
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("onSeq beyond the cursor pulls windows until latest, below it does nothing", async () => {
  const replica = fakeReplica();
  const windows = [
    feed({ next_since: 7, latest_seq: 9 }),
    feed({ next_since: 9, latest_seq: 9 }),
  ];
  const fetchJson = vi.fn(async (path: string) => {
    if (path.startsWith("/api/sync/changes")) return windows.shift() ?? feed({ next_since: 9, latest_seq: 9 });
    throw new Error(`unexpected ${path}`);
  });
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start(); // catches up to 9 (two windows)
  const callsAfterStart = fetchJson.mock.calls.length;
  sync.onSeq(3); // stale nudge: cursor is already 9
  await sync.idle();
  expect(fetchJson.mock.calls.length).toBe(callsAfterStart);
  sync.onSeq(12);
  await sync.idle();
  expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=9");
});

test("a needs-bootstrap feed answer re-bootstraps when the queue is empty", async () => {
  const replica = fakeReplica({
    applyChanges: vi.fn()
      .mockResolvedValueOnce({ status: "needs-bootstrap" })
      .mockResolvedValue({ status: "applied", cursor: 5 }),
  });
  const fetchJson = vi.fn(async (path: string) =>
    path === "/api/sync/snapshot" ? SNAP : feed());
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(replica.calls).toContain("prepareRecovery");
  expect(replica.calls).toContain("commitRecovery");
  expect(fetchJson).toHaveBeenCalledWith("/api/sync/snapshot");
});

test("schema mismatch flushes pending batches before reset, in order", async () => {
  const posted: unknown[] = [];
  const replica = fakeReplica({}, {
    schemaMismatch: true,
    pendingBatches: [
      { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
      { id: 2, batch_id: "b-2", ops: [{ op: "delete", uid: "uid_a2" }], poisoned: true },
      { id: 3, batch_id: "b-3", ops: [{ op: "delete", uid: "uid_a3" }], poisoned: false },
    ],
  });
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") { posted.push(JSON.parse(String(init?.body))); return { ok: true }; }
    if (path === "/api/sync/snapshot") return SNAP;
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  // poisoned batch b-2 is NOT retried; the others flush oldest-first
  expect(posted.map((b) => (b as { batch_id: string }).batch_id)).toEqual(["b-1", "b-3"]);
  expect(replica.calls).toContain("commitRecovery");
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("a failed recovery flush keeps the database and reports the failure", async () => {
  const replica = fakeReplica({}, {
    schemaMismatch: true,
    pendingBatches: [
      { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
    ],
  });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/ops") throw new Error("network down");
    return SNAP;
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();
  expect(replica.calls).not.toContain("reset");
  expect(replica.calls).toContain("abortRecovery");
  expect(replica.calls).not.toContain("commitRecovery");
  expect(states.at(-1)).toEqual({ mode: "recovery-failed", error: "network down" });
});

test("a failed recovery snapshot aborts the lease and retains durable rows", async () => {
  const replica = fakeReplica({}, {
    schemaMismatch: true,
    pendingBatches: [
      { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
    ],
  });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/ops") return { ok: true };
    if (path === "/api/sync/snapshot") throw new Error("snapshot offline");
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });

  await sync.start();

  expect(replica.calls).toContain("abortRecovery");
  expect(replica.calls).not.toContain("commitRecovery");
  expect(states.at(-1)).toEqual({
    mode: "recovery-failed", error: "snapshot offline",
  });
});

test("a failed feed-rebootstrap flush aborts through the shared coordinator", async () => {
  const batch: PendingBatch = {
    id: 8, batch_id: "b-8",
    ops: [{ op: "delete", uid: "uid_a8" }], poisoned: false,
  };
  const replica = fakeReplica({
    applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
    prepareRecovery: async () => ({ token: "lease-feed", batches: [batch] }),
  });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/ops") throw new Error("feed flush offline");
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });

  await sync.start();

  expect(replica.calls).toContain("abortRecovery");
  expect(replica.calls).not.toContain("commitRecovery");
  expect(states.at(-1)).toEqual({
    mode: "recovery-failed", error: "feed flush offline",
  });
});

test("schema recovery follows the queue/lease/flush/snapshot/commit trace", async () => {
  const trace: string[] = [];
  const batches: PendingBatch[] = [
    { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
    { id: 2, batch_id: "b-2", ops: [{ op: "delete", uid: "uid_a2" }], poisoned: false },
  ];
  const replica = fakeReplica({
    prepareRecovery: async () => {
      trace.push("prepare lease");
      return { token: "lease-1", batches };
    },
    commitRecovery: async (token, input) => {
      expect(token).toBe("lease-1");
      expect(input).toEqual({ kind: "reset", snapshot: SNAP });
      trace.push("compare final durable rows");
      trace.push("reset-or-rebase plus snapshot");
      trace.push("release lease");
    },
  }, { schemaMismatch: true, pendingBatches: batches });
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") {
      trace.push(`flush ${JSON.parse(String(init?.body)).batch_id}`);
      return { ok: true };
    }
    if (path === "/api/sync/snapshot") {
      trace.push("fetch snapshot");
      return SNAP;
    }
    return feed();
  });
  const queue = {
    pause: () => { trace.push("pause queue"); },
    resume: () => { trace.push("resume queue"); },
  };
  const { onState } = collector();
  const sync = createReplicaSync({
    replica, fetchJson, clientId: "c1", onState, queue,
  });

  await sync.start();

  expect(trace).toEqual([
    "pause queue",
    "prepare lease",
    "flush b-1",
    "flush b-2",
    "fetch snapshot",
    "compare final durable rows",
    "reset-or-rebase plus snapshot",
    "release lease",
    "resume queue",
  ]);
});

test("feed rebootstrap uses the same recovery coordinator trace", async () => {
  const trace: string[] = [];
  const batches: PendingBatch[] = [
    { id: 4, batch_id: "b-4", ops: [{ op: "delete", uid: "uid_a4" }], poisoned: false },
  ];
  const replica = fakeReplica({
    applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
    prepareRecovery: async () => {
      trace.push("prepare lease");
      return { token: "lease-feed", batches };
    },
    commitRecovery: async (_token, input) => {
      expect(input.kind).toBe("rebase");
      trace.push("compare final durable rows");
      trace.push("reset-or-rebase plus snapshot");
      trace.push("release lease");
    },
  });
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") {
      trace.push(`flush ${JSON.parse(String(init?.body)).batch_id}`);
      return { ok: true };
    }
    if (path === "/api/sync/snapshot") {
      trace.push("fetch snapshot");
      return SNAP;
    }
    return feed();
  });
  const queue = {
    pause: () => { trace.push("pause queue"); },
    resume: () => { trace.push("resume queue"); },
  };
  const { onState } = collector();
  const sync = createReplicaSync({
    replica, fetchJson, clientId: "c1", onState, queue,
  });

  await sync.start();

  expect(trace).toEqual([
    "pause queue",
    "prepare lease",
    "flush b-4",
    "fetch snapshot",
    "compare final durable rows",
    "reset-or-rebase plus snapshot",
    "release lease",
    "resume queue",
  ]);
});

test("a final durable-row mismatch aborts, retains the database, and reports recovery-failed", async () => {
  const trace: string[] = [];
  const batches: PendingBatch[] = [
    { id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false },
  ];
  const replica = fakeReplica({
    prepareRecovery: async () => {
      trace.push("prepare");
      return { token: "lease-1", batches };
    },
    commitRecovery: async () => {
      trace.push("compare");
      throw new Error("pending rows changed during recovery");
    },
    abortRecovery: async () => { trace.push("abort"); },
  }, { schemaMismatch: true, pendingBatches: batches });
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/ops") return { ok: true };
    if (path === "/api/sync/snapshot") return SNAP;
    return feed();
  });
  const queue = {
    pause: () => { trace.push("pause"); },
    resume: () => { trace.push("resume"); },
  };
  const { states, onState } = collector();
  const sync = createReplicaSync({
    replica, fetchJson, clientId: "c1", onState, queue,
  });

  await sync.start();

  expect(trace).toEqual(["pause", "prepare", "compare", "abort", "resume"]);
  expect(replica.calls).not.toContain("reset");
  expect(states.at(-1)).toEqual({
    mode: "recovery-failed", error: "pending rows changed during recovery",
  });
});

test("overlapping nudges coalesce into a trailing pull", async () => {
  const replica = fakeReplica();
  let release!: (v: Changes) => void;
  const gate = new Promise<Changes>((r) => { release = r; });
  const fetchJson = vi.fn()
    .mockImplementationOnce(async () => gate)               // start's catch-up pull
    .mockImplementation(async () => feed({ next_since: 20, latest_seq: 20 }));
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  const started = sync.start();
  while (fetchJson.mock.calls.length === 0) await Promise.resolve();
  sync.onSeq(15);
  sync.onSeq(16); // both while the first pull hangs -> one trailing pull
  release(feed({ next_since: 9, latest_seq: 9 }));
  await started;
  await sync.idle();
  // one hanging pull + windows: no unbounded fan-out
  expect(fetchJson.mock.calls.length).toBeLessThanOrEqual(3);
  expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=9");
});
