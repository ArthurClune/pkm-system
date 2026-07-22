import { expect, test, vi } from "vitest";
import type { ApplyResult, Changes, Snapshot } from "../replica/apply";
import type { PendingBatch, Replica, ReplicaInit } from "../replica/client";
import {
  createReplicaSync, PENDING_CHANGED_CAP, ResetBlockedError, RETRY_BASE_MS,
  type ReplicaState,
} from "./replicaSync";

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
    poisonedBatches: () => rec("poisonedBatches", []),
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

test("poison rebase waits for an in-flight guarded feed before its snapshot", async () => {
  let releaseFeed!: () => void;
  const feedGate = new Promise<void>((resolve) => { releaseFeed = resolve; });
  let changeCalls = 0;
  let snapshotCalls = 0;
  const replica = fakeReplica();
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/sync/snapshot") {
      snapshotCalls += 1;
      return SNAP;
    }
    changeCalls += 1;
    if (changeCalls === 2) await feedGate;
    return feed({ next_since: 6, latest_seq: 6 });
  });
  const queue = { pause: vi.fn(), resume: vi.fn() };
  const { onState } = collector();
  const sync = createReplicaSync({
    replica, fetchJson, clientId: "c1", onState, queue,
  });
  await sync.start();

  sync.onSeq(9);
  await vi.waitFor(() => { expect(changeCalls).toBe(2); });
  const repair = sync.rebaseAuthoritative("poison");
  await Promise.resolve();
  expect(snapshotCalls).toBe(0);

  releaseFeed();
  await repair;
  expect(snapshotCalls).toBe(1);
  expect(queue.resume).not.toHaveBeenCalled();
});

test("poison owns recovery when a held feed needs bootstrap through failure and retry", async () => {
  const poisoned: PendingBatch = {
    id: 1, batch_id: "poisoned", ops: [{ op: "delete", uid: "uid_bad" }],
    poisoned: true,
  };
  const later: PendingBatch = {
    id: 2, batch_id: "later-valid", ops: [{ op: "delete", uid: "uid_good" }],
    poisoned: false,
  };
  let applyCall = 0;
  const replica = fakeReplica({
    applyChanges: vi.fn(async (window: Changes) => {
      applyCall += 1;
      return applyCall === 1
        ? { status: "applied" as const, cursor: window.next_since }
        : { status: "needs-bootstrap" as const };
    }),
    prepareRecovery: vi.fn(async () => ({
      token: `lease-${applyCall}`, batches: [poisoned, later],
    })),
  });
  let releaseHeldFeed!: () => void;
  const heldFeed = new Promise<void>((resolve) => { releaseHeldFeed = resolve; });
  let releaseRetrySnapshot!: () => void;
  const retrySnapshot = new Promise<void>((resolve) => {
    releaseRetrySnapshot = resolve;
  });
  let changesCall = 0;
  let snapshotPhase: "first" | "between" | "retry" = "first";
  let retrySnapshotStarted = false;
  let snapshotCalls = 0;
  const posted: string[] = [];
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") {
      posted.push((JSON.parse(String(init?.body)) as { batch_id: string }).batch_id);
      return { ok: true };
    }
    if (path === "/api/sync/snapshot") {
      snapshotCalls += 1;
      if (snapshotPhase === "first") throw new Error("poison snapshot offline");
      if (snapshotPhase === "retry") {
        retrySnapshotStarted = true;
        await retrySnapshot;
      }
      return { ...SNAP, seq: 10 };
    }
    changesCall += 1;
    if (changesCall === 2) await heldFeed;
    return feed({ next_since: 6, latest_seq: 6 });
  });
  const queue = { pause: vi.fn(), resume: vi.fn() };
  const { onState } = collector();
  const sync = createReplicaSync({
    replica, fetchJson, clientId: "c1", onState, queue,
  });
  await sync.start();

  sync.onSeq(9);
  await vi.waitFor(() => { expect(changesCall).toBe(2); });
  const firstRepair = sync.rebaseAuthoritative("poison")
    .then(() => null, (error: unknown) => error);
  releaseHeldFeed();
  const firstError = await firstRepair;

  // A failed poison snapshot retains recovery ownership. Another feed that
  // needs bootstrap must not enter normal Task 2 flush/resume while Retry is
  // still pending.
  snapshotPhase = "between";
  sync.onSeq(9);
  await sync.idle();

  snapshotPhase = "retry";
  const retry = sync.rebaseAuthoritative("poison");
  await vi.waitFor(() => { expect(retrySnapshotStarted).toBe(true); });
  const postedBeforeRetryCommit = [...posted];
  const resumesBeforeRetryCommit = queue.resume.mock.calls.length;
  releaseRetrySnapshot();
  await retry;

  expect(firstError).toMatchObject({ message: "poison snapshot offline" });
  expect(postedBeforeRetryCommit).toEqual([]);
  expect(posted).toEqual([]);
  expect(resumesBeforeRetryCommit).toBe(0);
  expect(queue.resume).not.toHaveBeenCalled();
  expect(snapshotCalls).toBe(2); // failed poison snapshot + successful Retry
  expect(sync.completeAuthoritativeRepair).toBeTypeOf("function");
  sync.completeAuthoritativeRepair("poison");
});

test("poison preempts a normal recovery lease before its stale flush starts", async () => {
  const staleLease: PendingBatch[] = [
    { id: 1, batch_id: "rejected", ops: [{ op: "delete", uid: "uid_bad" }],
      poisoned: false },
    { id: 2, batch_id: "later-valid", ops: [{ op: "delete", uid: "uid_good" }],
      poisoned: false },
  ];
  let applyCall = 0;
  let leaseAcquired!: () => void;
  const acquired = new Promise<void>((resolve) => { leaseAcquired = resolve; });
  let releaseLease!: () => void;
  const leaseGate = new Promise<void>((resolve) => { releaseLease = resolve; });
  const abortRecovery = vi.fn(async () => undefined);
  const replica = fakeReplica({
    applyChanges: vi.fn(async (window: Changes) => {
      applyCall += 1;
      return applyCall === 1
        ? { status: "applied" as const, cursor: window.next_since }
        : { status: "needs-bootstrap" as const };
    }),
    prepareRecovery: vi.fn(async () => {
      leaseAcquired();
      await leaseGate;
      return { token: "stale-normal-lease", batches: staleLease };
    }),
    abortRecovery,
  });
  const posted: string[] = [];
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") {
      posted.push((JSON.parse(String(init?.body)) as { batch_id: string }).batch_id);
      return { ok: true };
    }
    if (path === "/api/sync/snapshot") return { ...SNAP, seq: 10 };
    return feed({ next_since: 6, latest_seq: 6 });
  });
  let signalPoisonPending: () => void = () => undefined;
  const queue = {
    pause: vi.fn(),
    resume: vi.fn(),
    onPoisonPending: (listener: () => void) => {
      signalPoisonPending = listener;
      return () => undefined;
    },
  };
  const { onState } = collector();
  const sync = createReplicaSync({
    replica, fetchJson, clientId: "c1", onState, queue,
  });
  await sync.start();

  sync.onSeq(9);
  await acquired; // normal recovery owns a stale pre-mark lease snapshot
  signalPoisonPending(); // 4xx observed; markPoisoned is blocked by that lease
  releaseLease();
  await sync.idle();

  expect(posted).toEqual([]);
  expect(abortRecovery).toHaveBeenCalledWith("stale-normal-lease");
  expect(queue.resume).not.toHaveBeenCalled();
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

test("reports stalled after 3 consecutive failed pulls and retries with backoff", async () => {
  vi.useFakeTimers();
  try {
    const replica = fakeReplica();
    const fetchJson = vi.fn(async () => { throw new Error("changes offline"); });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });

    await sync.start(); // pull 1 fails (not yet stalled)
    expect(states.at(-1)).toEqual({ mode: "ready" });

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // retry 2 fails
    expect(states.some((s) => s.mode === "stalled")).toBe(false);

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // retry 3 fails -> stalled
    expect(states.at(-1)).toEqual({ mode: "stalled", error: expect.any(String) });

    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 4); // retry 4 also fails, stays stalled
    expect(states.filter((s) => s.mode === "stalled").length).toBeGreaterThan(0);
    expect(states.at(-1)).toEqual({ mode: "stalled", error: expect.any(String) });
  } finally {
    vi.useRealTimers();
  }
});

test("a successful pull clears the stall and resets the backoff", async () => {
  vi.useFakeTimers();
  try {
    const replica = fakeReplica();
    let failing = true;
    const fetchJson = vi.fn(async (path: string) => {
      if (failing) throw new Error("changes offline");
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });

    await sync.start(); // failure 1
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // failure 2
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // failure 3 -> stalled
    expect(states.at(-1)).toEqual({ mode: "stalled", error: expect.any(String) });

    failing = false;
    const callsBeforeRecovery = fetchJson.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 4); // scheduled retry now succeeds
    expect(states.at(-1)).toEqual({ mode: "ready" });

    // backoff reset: the next failure retries at RETRY_BASE_MS, not the
    // multi-second delay it would have reached had backoff kept growing.
    failing = true;
    sync.onSeq(9999);
    await sync.idle();
    const callsBeforeReset = fetchJson.mock.calls.length;
    expect(callsBeforeReset).toBeGreaterThan(callsBeforeRecovery);
    await vi.advanceTimersByTimeAsync(RETRY_BASE_MS - 1);
    expect(fetchJson.mock.calls.length).toBe(callsBeforeReset);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsBeforeReset);
  } finally {
    vi.useRealTimers();
  }
});

test("caps pending-changed retries per pull", async () => {
  const applyChanges = vi.fn(async () => ({ status: "pending-changed" as const }));
  const replica = fakeReplica({ applyChanges });
  const fetchJson = vi.fn(async () => feed());
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });

  await sync.start();

  expect(applyChanges.mock.calls.length).toBe(PENDING_CHANGED_CAP);
  // a single starved pull is one failed attempt, not (yet) a stall
  expect(states.some((s) => s.mode === "stalled")).toBe(false);
});

test("resetLocalData flushes, resets and bootstraps", async () => {
  const batch: PendingBatch = {
    id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false,
  };
  const posted: string[] = [];
  const commitRecovery = vi.fn(async (_token: string, input) => {
    expect(input).toEqual({ kind: "reset", snapshot: { ...SNAP, seq: 42 } });
  });
  const replica = fakeReplica({
    prepareRecovery: async () => ({ token: "lease-reset", batches: [batch] }),
    commitRecovery,
  });
  const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/ops") {
      posted.push((JSON.parse(String(init?.body)) as { batch_id: string }).batch_id);
      return { ok: true };
    }
    if (path === "/api/sync/snapshot") return { ...SNAP, seq: 42 };
    return feed();
  });
  const { states, onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();

  await sync.resetLocalData({ discardPending: false });

  expect(posted).toEqual(["b-1"]);
  expect(commitRecovery).toHaveBeenCalled();
  expect(states.at(-1)).toEqual({ mode: "ready" });
});

test("resetLocalData without discardPending surfaces a blocked reset when flush fails", async () => {
  const batch: PendingBatch = {
    id: 1, batch_id: "b-1", ops: [{ op: "delete", uid: "uid_a1" }], poisoned: false,
  };
  const replica = fakeReplica({
    prepareRecovery: async () => ({ token: "lease-reset", batches: [batch] }),
  });
  let snapshotCalls = 0;
  const fetchJson = vi.fn(async (path: string) => {
    if (path === "/api/ops") throw new Error("flush offline");
    if (path === "/api/sync/snapshot") { snapshotCalls += 1; return SNAP; }
    return feed();
  });
  const { onState } = collector();
  const sync = createReplicaSync({ replica, fetchJson, clientId: "c1", onState });
  await sync.start();

  let caught: unknown;
  try {
    await sync.resetLocalData({ discardPending: false });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ResetBlockedError);
  expect((caught as ResetBlockedError).pending).toBe(1);
  expect(replica.calls).toContain("abortRecovery");
  expect(replica.calls).not.toContain("commitRecovery");
  expect(snapshotCalls).toBe(0);
});
