import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError, OfflineError } from "../api/client";
import type { BatchId, ClientId, SyncSeq } from "../api/brands";
import type { ApplyResult, Changes, Snapshot } from "../replica/apply";
import type { SkippedOp } from "../api/payloads";
import type {
  DroppedBatch, PendingBatch, PendingRowId, Replica, ReplicaInit,
} from "../replica/client";
import { ReplicaError, ReplicaUnusableError } from "../replica/errors";
import { uid } from "../test-helpers";
import {
  createReplicaSync, PENDING_CHANGED_CAP, PENDING_IDS_CAP, ResetBlockedError, RETRY_BASE_MS,
  RETRY_MAX_MS, STALL_AFTER_FAILURES, WINDOW_STRIKES, type ReplicaState,
} from "./replicaSync";

// Every test here picks an arbitrary id/batch-id string, same shape as the
// production mint; these mint the brand once rather than at every call.
const CID = "c1" as ClientId;
const bid = (s: string): BatchId => s as BatchId;

const SNAP: Snapshot = {
  generation: "gen-1", plain_space_title_canonicalization: false,
  seq: (5 as SyncSeq), pages: [], blocks: [], sidebar: [],
};

const feed = (over: Partial<Changes> = {}): Changes => ({
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: (5 as SyncSeq), latest_seq: (5 as SyncSeq),
  pages: [], blocks: [], sidebar: [], tombstones: [], ...over,
});

const EMPTY_FEED: Changes = feed();

function fakeReplica(over: Partial<Replica> = {},
                     init: Partial<ReplicaInit> = {}): Replica & { calls: string[] } {
  const calls: string[] = [];
  const rec = <T>(name: string, value: T) => {
    calls.push(name);
    return Promise.resolve(value);
  };
  return {
    calls,
    init: () => rec("init", { empty: false, cursor: 5,
                              schemaMismatch: false, pendingBatches: [],
                              ...init } as ReplicaInit),
    applySnapshot: () => rec("applySnapshot", undefined),
    applyChanges: (f: Changes) =>
      rec<ApplyResult>("applyChanges", { status: "applied", cursor: f.next_since }),
    enqueue: () => rec("enqueue", { pending: 0, batchId: bid("batch-1") }),
    nextBatch: () => rec<PendingBatch | null>("nextBatch", null),
    deleteBatch: () => rec("deleteBatch", { pending: 0 }),
    markPoisoned: () => rec("markPoisoned", { pending: 0, matched: true }),
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
    diagnostics: () => rec("diagnostics", {
      sqliteVersion: "fake", quickCheck: ["ok"],
      integrity: { blocks_fts: "ok", pages_fts: "ok" },
      counts: { pages: 0, blocks: 0, pending_ops: 0,
                pages_fts_docsize: 0, blocks_fts_docsize: 0 },
      meta: { cursor: "5", generation: "gen-1", schema_version: null },
    }),
    dispose: () => rec("dispose", undefined),
    ...over,
  };
}

function collector() {
  const states: ReplicaState[] = [];
  return { states, onState: (s: ReplicaState) => { states.push(s); } };
}

// Tests that drive a failure path on purpose spy on console.warn and assert
// the recovery log they provoke; `logged` counts lines containing `text`.
const quietWarn = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);
const logged = (warn: ReturnType<typeof quietWarn>, text: string) =>
  warn.mock.calls.filter(([m]) => typeof m === "string" && m.includes(text)).length;
afterEach(() => { vi.restoreAllMocks(); });

describe("start, bootstrap and feed pulls", () => {
  test("start on an empty replica bootstraps from the snapshot then is ready", async () => {
    const replica = fakeReplica({}, { empty: true, cursor: (0 as SyncSeq) });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start();
    // untimed: a cold-start whole-graph download on a slow link must not be
    // abandoned at the ordinary read deadline
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/sync/snapshot", undefined, { timeoutMs: null },
    );
    expect(replica.calls).toContain("applySnapshot");
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("marks pkm:replica-ready once the first start completes", async () => {
    const mark = vi.spyOn(performance, "mark");
    const replica = fakeReplica({}, { empty: true, cursor: (0 as SyncSeq) });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { onState } = collector();
    try {
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
      await sync.start();
      expect(mark).toHaveBeenCalledWith("pkm:replica-ready");
    } finally {
      mark.mockRestore();
    }
  });

  test("start on a warm replica skips the snapshot and catches up the feed", async () => {
    const replica = fakeReplica();
    const fetchJson = vi.fn(async () => feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }));
    const { onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
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
        id: 1, batch_id: bid("batch-1"), ops: [], poisoned: false,
      }])
      .mockResolvedValueOnce([]);
    const replica = fakeReplica({ applyChanges, pendingBatches });
    const stale = feed({ next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq) });
    const fetchJson = vi.fn(async (_path: string) => stale);
    const { onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();

    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(fetchJson.mock.calls.map(([path]) => path))
      .toEqual(["/api/sync/changes?since=5&pending=batch-1",
                "/api/sync/changes?since=5"]);
    expect(applyChanges.mock.calls).toEqual([
      [stale, [1]],
      [stale, []],
    ]);
  });

  test("no-replica init reports mode and never fetches", async () => {
    const replica = fakeReplica({
      init: () => Promise.reject(new ReplicaUnusableError("OPFS is not available")),
    });
    const fetchJson = vi.fn();
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start();
    expect(states.at(-1)).toEqual({ mode: "no-replica" });
    expect(fetchJson).not.toHaveBeenCalled();
  });

  test("a session whose replica cannot open never pulls, however often start() is called",
  async () => {
    // What `disabled` used to buy: start() short-circuiting for the rest of the
    // session. What buys it now: init() replaying the worker's latched failure,
    // which is the same fact at its source instead of a copy kept in sync by
    // convention.
    const feeds: string[] = [];
    const replica = fakeReplica();
    replica.init = () => Promise.reject(new ReplicaUnusableError("no openable database"));
    const states: ReplicaState[] = [];
    const sync = createReplicaSync({
      replica,
      fetchJson: async (path: string) => {
        if (path.startsWith("/api/sync/changes")) feeds.push(path);
        return EMPTY_FEED;
      },
      clientId: CID,
      onState: (s) => states.push(s),
    });
    await sync.start();
    await sync.start();
    await sync.start();
    expect(feeds).toEqual([]);
    expect(states.map((s) => s.mode)).toEqual(["no-replica", "no-replica", "no-replica"]);
  });

  test("appliedVersion answers 'cannot tell' only for a database that is gone, "
     + "not for a pull that failed", async () => {
    // The asymmetry the resync narrowing rests on. An ordinary failed pull keeps
    // a number: the cursor still remembers what was applied, so the next
    // successful pull re-reads the same window and reports the change then. The
    // worker's latched open failure keeps no such promise -- every later pull
    // replays it until close() -- so the answer has to become null or views
    // would never refetch again for the rest of the session.
    let failure: Error | null = null;
    const replica = fakeReplica({
      pendingBatches: async () => {
        if (failure) throw failure;
        return [];
      },
    });
    const sync = createReplicaSync({
      replica, fetchJson: async () => EMPTY_FEED, clientId: CID,
      onState: () => undefined,
    });
    await sync.start();
    const healthy = sync.appliedVersion();
    expect(healthy).not.toBeNull();

    failure = new ReplicaError("disk I/O error");
    await sync.start();
    expect(sync.appliedVersion()).toBe(healthy);

    failure = new ReplicaUnusableError("no openable database");
    await sync.start();
    expect(sync.appliedVersion()).toBeNull();
    sync.stop(); // the failed pulls scheduled a backoff retry
  });

  test("resetLocalData cannot revive a session whose replica cannot open", async () => {
    // The explicit `disabled` guard is gone; prepareRecovery rejects on the latch
    // before resetLocalData can set `started` or force mode "ready". The
    // rejection propagating by identity is not the property under test -- a
    // reorder that moved `started = true` above prepareRecovery() would still
    // let that rejection through unchanged while leaving the session revived.
    // `started` has no external getter, so the tripwire is behavioural: a start()
    // call afterwards takes the `if (started)` branch straight into pull() and
    // hits the changes feed, instead of re-running doStart() -> init() and
    // reporting "no-replica" with no fetch at all.
    const feeds: string[] = [];
    const replica = fakeReplica();
    const unusable = new ReplicaUnusableError("no openable database");
    replica.init = () => Promise.reject(unusable);
    replica.prepareRecovery = () => Promise.reject(unusable);
    const sync = createReplicaSync({
      replica,
      fetchJson: async (path: string) => {
        if (path.startsWith("/api/sync/changes")) feeds.push(path);
        return EMPTY_FEED;
      },
      clientId: CID,
      onState: () => undefined,
    });
    await sync.start();
    await expect(sync.resetLocalData({ discardPending: true })).rejects.toBe(unusable);
    await sync.start();
    expect(feeds).toEqual([]);
  });

  test("a hydrated replica reaches ready with the network down (cold start offline)", async () => {
    // start() must not need the socket: a cold start offline serves the app
    // shell from the service worker and content from the replica
    const replica = fakeReplica();
    const fetchJson = vi.fn(async () => { throw new TypeError("offline"); });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start(); // catch-up pull fails quietly; readiness is local
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("concurrent start calls share one initialization", async () => {
    // mount and the first socket connect both call start(): the bootstrap
    // must run exactly once
    const replica = fakeReplica({}, { empty: true, cursor: (0 as SyncSeq) });
    const fetchJson = vi.fn(async (path: string) =>
      path === "/api/sync/snapshot" ? SNAP : feed());
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await Promise.all([sync.start(), sync.start()]);
    expect(replica.calls.filter((c) => c === "init")).toHaveLength(1);
    expect(replica.calls.filter((c) => c === "applySnapshot")).toHaveLength(1);
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("a failed empty-replica bootstrap (offline first visit) retries on next start", async () => {
    const replica = fakeReplica({}, { empty: true, cursor: (0 as SyncSeq) });
    const fetchJson = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(async (path: string) =>
        path === "/api/sync/snapshot" ? SNAP : feed());
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await expect(sync.start()).rejects.toThrow("offline");
    await sync.start(); // reconnect: succeeds this time
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("onSeq beyond the cursor pulls windows until latest, below it does nothing", async () => {
    const replica = fakeReplica();
    const windows = [
      feed({ next_since: (7 as SyncSeq), latest_seq: (9 as SyncSeq) }),
      feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }),
    ];
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith("/api/sync/changes")) return windows.shift() ?? feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) });
      throw new Error(`unexpected ${path}`);
    });
    const { onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start(); // catches up to 9 (two windows)
    const callsAfterStart = fetchJson.mock.calls.length;
    sync.onSeq((3 as SyncSeq)); // stale nudge: cursor is already 9
    await sync.idle();
    expect(fetchJson.mock.calls.length).toBe(callsAfterStart);
    sync.onSeq((12 as SyncSeq));
    await sync.idle();
    expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=9");
  });
});

describe("poison recovery ownership", () => {
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
      return feed({ next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq) });
    });
    const queue = { pause: vi.fn(), resume: vi.fn() };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();

    sync.onSeq((9 as SyncSeq));
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
      id: (1 as PendingRowId), batch_id: bid("poisoned"), ops: [{ op: "delete", uid: uid("uid_bad") }],
      poisoned: true,
    };
    const later: PendingBatch = {
      id: (2 as PendingRowId), batch_id: bid("later-valid"), ops: [{ op: "delete", uid: uid("uid_good") }],
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
      return feed({ next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq) });
    });
    const queue = { pause: vi.fn(), resume: vi.fn() };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();

    sync.onSeq((9 as SyncSeq));
    await vi.waitFor(() => { expect(changesCall).toBe(2); });
    const firstRepair = sync.rebaseAuthoritative("poison")
      .then(() => null, (error: unknown) => error);
    releaseHeldFeed();
    const firstError = await firstRepair;

    // A failed poison snapshot retains recovery ownership. Another feed that
    // needs bootstrap must not enter normal Task 2 flush/resume while Retry is
    // still pending.
    snapshotPhase = "between";
    sync.onSeq((9 as SyncSeq));
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
      { id: (1 as PendingRowId), batch_id: bid("rejected"), ops: [{ op: "delete", uid: uid("uid_bad") }],
        poisoned: false },
      { id: (2 as PendingRowId), batch_id: bid("later-valid"), ops: [{ op: "delete", uid: uid("uid_good") }],
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
      return feed({ next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq) });
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
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();

    sync.onSeq((9 as SyncSeq));
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
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start();
    expect(replica.calls).toContain("prepareRecovery");
    expect(replica.calls).toContain("commitRecovery");
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/sync/snapshot", undefined, { timeoutMs: null },
    );
  });

  test("an unmatched poison round releases ownership so a later needs-bootstrap pull can rebootstrap",
  async () => {
    let applyCall = 0;
    const replica = fakeReplica({
      applyChanges: vi.fn(async (window: Changes) => {
        applyCall += 1;
        return applyCall === 1
          ? { status: "applied" as const, cursor: window.next_since }
          : { status: "needs-bootstrap" as const };
      }),
    });
    const fetchJson = vi.fn(async (path: string) =>
      path === "/api/sync/snapshot" ? SNAP : feed());
    let signalPoisonPending: () => void = () => undefined;
    let signalUnmatched: () => void = () => undefined;
    const queue = {
      pause: vi.fn(),
      resume: vi.fn(),
      onPoisonPending: (listener: () => void) => {
        signalPoisonPending = listener;
        return () => undefined;
      },
      onPoisonMarkUnmatched: (listener: () => void) => {
        signalUnmatched = listener;
        return () => undefined;
      },
    };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start(); // consumes applyCall #1 ("applied"), nothing poison-related yet

    // Calling the unmatched signal with no claim held is a no-op: nothing to
    // release, so resume must not fire yet.
    signalUnmatched();
    expect(queue.resume).not.toHaveBeenCalled();

    signalPoisonPending(); // claims ownership, as rejectDurableBatch would
    signalUnmatched(); // the marking round matched nothing
    expect(queue.resume).toHaveBeenCalledTimes(1);

    sync.onSeq((9 as SyncSeq));
    await sync.idle(); // drives applyCall #2 ("needs-bootstrap")

    expect(replica.calls).toContain("prepareRecovery"); // rebase actually ran
    expect(replica.calls).toContain("commitRecovery");
  });
});

describe("recovery flushes and the shared coordinator", () => {
  test("schema mismatch flushes pending batches before reset, in order", async () => {
    const posted: unknown[] = [];
    const replica = fakeReplica({}, {
      schemaMismatch: true,
      pendingBatches: [
        { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
        { id: (2 as PendingRowId), batch_id: bid("b-2"), ops: [{ op: "delete", uid: uid("uid_a2") }], poisoned: true },
        { id: (3 as PendingRowId), batch_id: bid("b-3"), ops: [{ op: "delete", uid: uid("uid_a3") }], poisoned: false },
      ],
    });
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/ops") { posted.push(JSON.parse(String(init?.body))); return { ok: true }; }
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start();
    // poisoned batch b-2 is NOT retried; the others flush oldest-first
    expect(posted.map((b) => (b as { batch_id: string }).batch_id)).toEqual(["b-1", "b-3"]);
    expect(replica.calls).toContain("commitRecovery");
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("the recovery flush delivers each batch's lane-ahead entries before posting it",
  async () => {
    // flushBatches posts leased durable rows on its own, knowing nothing about
    // the fallback lane — a second overtaking path distinct from ordinary
    // drain ordering. It must ask the queue's deliverLaneAhead for each batch
    // before posting it, so a lane entry the batch follows still goes out
    // first. A fake queue recording call order is enough to pin this: the
    // queue's own contract for deliverLaneAhead is tested at the opQueue level.
    const trace: string[] = [];
    const batches: PendingBatch[] = [
      { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
      { id: (2 as PendingRowId), batch_id: bid("b-2"), ops: [{ op: "delete", uid: uid("uid_a2") }], poisoned: false },
    ];
    const replica = fakeReplica({}, { schemaMismatch: true, pendingBatches: batches });
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/ops") {
        trace.push(`flush ${JSON.parse(String(init?.body)).batch_id}`);
        return { ok: true };
      }
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const queue = {
      pause: () => undefined,
      resume: () => undefined,
      deliverLaneAhead: async (batchId: string) => {
        trace.push(`deliver lane ahead of ${batchId}`);
      },
    };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });

    await sync.start();

    expect(trace).toEqual([
      "deliver lane ahead of b-1",
      "flush b-1",
      "deliver lane ahead of b-2",
      "flush b-2",
    ]);
  });

  test("a recovery flush whose ack names a skipped op calls onSkipped once",
  async () => {
    const batches: PendingBatch[] = [
      { id: (1 as PendingRowId), batch_id: bid("b-1"),
       ops: [{ op: "update_text", uid: uid("uid_a1"), text: "x" }], poisoned: false },
    ];
    const replica = fakeReplica({}, { schemaMismatch: true, pendingBatches: batches });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") {
        return { ok: true, ts: 1, applied: 1, seq: 7,
                skipped: [{ index: 0, op: "update_text", uid: "uid_a1",
                           reason: "block_not_found", note_page: null }] };
      }
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { onState } = collector();
    const skips: void[] = [];
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    sync.onSkipped(() => skips.push(undefined));

    await sync.start();

    expect(skips).toHaveLength(1);
  });

  test("a recovery flush whose ack names no skipped op does not call onSkipped",
  async () => {
    const batches: PendingBatch[] = [
      { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
    ];
    const replica = fakeReplica({}, { schemaMismatch: true, pendingBatches: batches });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") return { ok: true, ts: 1, applied: 1, seq: 7, skipped: [] };
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { onState } = collector();
    const skips: void[] = [];
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    sync.onSkipped(() => skips.push(undefined));

    await sync.start();

    expect(skips).toEqual([]);
  });

  test("a failed recovery flush keeps the database and reports the failure", async () => {
    const replica = fakeReplica({}, {
      schemaMismatch: true,
      pendingBatches: [
        { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
      ],
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") throw new Error("network down");
      return SNAP;
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
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
        { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
      ],
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") return { ok: true };
      if (path === "/api/sync/snapshot") throw new Error("snapshot offline");
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();

    expect(replica.calls).toContain("abortRecovery");
    expect(replica.calls).not.toContain("commitRecovery");
    expect(states.at(-1)).toEqual({
      mode: "recovery-failed", error: "snapshot offline",
    });
  });

  test("a failed feed-rebootstrap flush aborts through the shared coordinator", async () => {
    const batch: PendingBatch = {
      id: (8 as PendingRowId), batch_id: bid("b-8"),
      ops: [{ op: "delete", uid: uid("uid_a8") }], poisoned: false,
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
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

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
      { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
      { id: (2 as PendingRowId), batch_id: bid("b-2"), ops: [{ op: "delete", uid: uid("uid_a2") }], poisoned: false },
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
      replica, fetchJson, clientId: CID, onState, queue,
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
      { id: (4 as PendingRowId), batch_id: bid("b-4"), ops: [{ op: "delete", uid: uid("uid_a4") }], poisoned: false },
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
      replica, fetchJson, clientId: CID, onState, queue,
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
      { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
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
      replica, fetchJson, clientId: CID, onState, queue,
    });

    await sync.start();

    expect(trace).toEqual(["pause", "prepare", "compare", "abort", "resume"]);
    expect(replica.calls).not.toContain("reset");
    expect(states.at(-1)).toEqual({
      mode: "recovery-failed", error: "pending rows changed during recovery",
    });
  });
});

describe("pull retries and the stall report", () => {
  test("overlapping nudges coalesce into a trailing pull", async () => {
    const replica = fakeReplica();
    let release!: (v: Changes) => void;
    const gate = new Promise<Changes>((r) => { release = r; });
    const fetchJson = vi.fn()
      .mockImplementationOnce(async () => gate)               // start's catch-up pull
      .mockImplementation(async () => feed({ next_since: (20 as SyncSeq), latest_seq: (20 as SyncSeq) }));
    const { onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    const started = sync.start();
    while (fetchJson.mock.calls.length === 0) await Promise.resolve();
    sync.onSeq((15 as SyncSeq));
    sync.onSeq((16 as SyncSeq)); // both while the first pull hangs -> one trailing pull
    release(feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }));
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
      // replica-shaped failure (an HTTP error surfaced as ApiError): this is
      // what "the replica can't make progress" looks like, as opposed to a
      // dropped connection -- see the finding 2 tests below.
      const fetchJson = vi.fn(async () => {
        throw new ApiError(503, "/api/sync/changes");
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

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
        if (failing) throw new ApiError(503, "/api/sync/changes");
        if (path === "/api/sync/snapshot") return SNAP;
        return feed();
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

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
      sync.onSeq((9999 as SyncSeq));
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
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();

    expect(applyChanges.mock.calls.length).toBe(PENDING_CHANGED_CAP);
    // a single starved pull is one failed attempt, not (yet) a stall
    expect(states.some((s) => s.mode === "stalled")).toBe(false);
  });

  test("pending-changed retries count per run, not per pull", async () => {
    // Each of the 6 windows races the local queue 5 times before it applies:
    // 30 pending-changed results in all (over the cap), never 20 in a row.
    const racesPerWindow = PENDING_CHANGED_CAP / 4;
    const windows = 6;
    let racesLeft = racesPerWindow;
    const applyChanges = vi.fn(async (f: Changes) => {
      if (racesLeft > 0) {
        racesLeft -= 1;
        return { status: "pending-changed" as const };
      }
      racesLeft = racesPerWindow;
      return { status: "applied" as const, cursor: f.next_since };
    });
    const replica = fakeReplica({ applyChanges }, { cursor: (0 as SyncSeq) });
    const fetchJson = vi.fn(async (path: string) => {
      const since = Number(new URL(path, "http://x").searchParams.get("since"));
      const next = Math.min(since + 1, windows);
      return feed({ next_since: (next as SyncSeq), latest_seq: (windows as SyncSeq) });
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();

    expect(applyChanges.mock.calls.length).toBe(windows * (racesPerWindow + 1));
    expect(applyChanges.mock.calls.length - windows).toBeGreaterThan(PENDING_CHANGED_CAP);
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("network-shaped pull failures never stall, however many retries", async () => {
    vi.useFakeTimers();
    try {
      const replica = fakeReplica();
      const fetchJson = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // failure 1: ready is still reported by doStart
      expect(states.at(-1)).toEqual({ mode: "ready" });

      // Advance well past the point where a stall-shaped failure run would
      // have crossed STALL_AFTER_FAILURES (3).
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
      }

      expect(states.some((s) => s.mode === "stalled")).toBe(false);
      // offline editing must stay enabled: mode never left "ready"
      expect(states.at(-1)).toEqual({ mode: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("pulls failing with ReplicaError still stall at 3", async () => {
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const replica = fakeReplica();
      const fetchJson = vi.fn(async () => {
        throw new ReplicaError("replica rpc failed", {});
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // failure 1
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // failure 2
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // failure 3 -> stalled
      expect(states.at(-1)).toEqual({ mode: "stalled", error: "replica rpc failed" });
      // each ReplicaError pull is a window that will not apply: the rebase
      // reports it, and the report's own POST fails with the same error
      expect(logged(warn, "re-snapshotting")).toBeGreaterThan(0);
      expect(logged(warn, "could not post diagnostics")).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("OfflineError pull failures never stall, however many retries", async () => {
    // The offline gateway throws a real OfflineError (status 0, extends
    // ApiError) for any route it does not serve locally -- the classifier used
    // to accept any ApiError, so three offline pulls crossed STALL_AFTER_FAILURES
    // and raised the "Local sync is stuck / Reset local data" banner for a plain
    // network outage.
    vi.useFakeTimers();
    try {
      const replica = fakeReplica();
      const fetchJson = vi.fn(async (path: string) => { throw new OfflineError(path); });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // failure 1
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // failure 2
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // failure 3 -- still not stalled
      expect(states.some((s) => s.mode === "stalled")).toBe(false);
      expect(states.at(-1)).toEqual({ mode: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("the retry does not reschedule while offline, and reconnect resumes it", async () => {
    // Side effect of the misclassification: the 60 s-capped retry kept
    // rescheduling for the whole offline session even though nothing but the
    // reconnect flow's own start() call could ever make it succeed. isOffline
    // is the connectivity signal replicaSync is handed (mirrors the offline
    // gateway's own `statusRef.current === "reconnecting"` predicate).
    vi.useFakeTimers();
    try {
      const replica = fakeReplica();
      let offline = true;
      let fail = true;
      const fetchJson = vi.fn(async (path: string) => {
        if (fail) throw new OfflineError(path);
        return feed();
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({
        replica, fetchJson, clientId: CID, onState, isOffline: () => offline,
      });
      await sync.start(); // failure 1, while offline
      const callsWhileOffline = fetchJson.mock.calls.length;

      // No retry timer was armed while offline: waiting well past even the
      // capped backoff produces no further pull attempts.
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 4);
      expect(fetchJson.mock.calls.length).toBe(callsWhileOffline);

      // Reconnect: the reconnect flow calls start() again on the next successful
      // connect (reconnectFlow.ts), which resumes the pull without needing the
      // suppressed retry timer.
      offline = false;
      fail = false;
      await sync.start();
      expect(fetchJson.mock.calls.length).toBeGreaterThan(callsWhileOffline);
      expect(states.at(-1)).toEqual({ mode: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("an unavailable-shaped pull failure never stalls", async () => {
    // A session reporting `stalled` on top of `no-replica` lets computeEditability
    // flip the whole session read-only, so an availability failure must not count
    // toward the stall threshold — however many times it happens.
    const states: ReplicaState[] = [];
    const replica = fakeReplica();
    replica.pendingBatches = () =>
      Promise.reject(new ReplicaUnusableError("no openable database"));
    const fetchJson = vi.fn(async () => feed());
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID,
      onState: (s) => states.push(s),
    });
    await sync.start();
    for (let i = 0; i < STALL_AFTER_FAILURES + 2; i += 1) {
      sync.onSeq((i + 100 as SyncSeq), true);
      await sync.idle();
    }
    expect(states.filter((s) => s.mode === "stalled")).toEqual([]);
  });

  test("a mix of network and replica errors stalls only once 3 replica-shaped failures accrue", async () => {
    vi.useFakeTimers();
    try {
      const replica = fakeReplica();
      const errors = [
        new TypeError("Failed to fetch"),
        new TypeError("Failed to fetch"),
        new ApiError(503, "/api/sync/changes"),
        new ApiError(503, "/api/sync/changes"),
        new ApiError(503, "/api/sync/changes"),
      ];
      let call = 0;
      const fetchJson = vi.fn(async () => { throw errors[Math.min(call++, errors.length - 1)]; });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // network failure 1/2 (not counted)
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // network failure 2/2 (not counted)
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // replica failure 1/3
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 4); // replica failure 2/3
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 8); // replica failure 3/3 -> stalled
      expect(states.at(-1)).toEqual({ mode: "stalled", error: expect.any(String) });
    } finally {
      vi.useRealTimers();
    }
  });

  test("repeatedly-failing in-pull recovery with a stall-shaped underlying error stalls at 3", async () => {
    // Before the fix, the needs-bootstrap path rethrew a synthetic plain Error
    // ("replica recovery failed during pull") instead of the recovery's real
    // failure, so isStallShaped never recognized it and consecutiveFailures
    // never advanced no matter how many times recovery failed.
    vi.useFakeTimers();
    try {
      const replica = fakeReplica({
        applyChanges: vi.fn(async () => ({ status: "needs-bootstrap" as const })),
      });
      const fetchJson = vi.fn(async (path: string) => {
        if (path === "/api/sync/snapshot") {
          throw new ReplicaError("replica rpc failed", {});
        }
        return feed();
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // recovery failure 1/3
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS); // recovery failure 2/3
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS * 2); // recovery failure 3/3 -> stalled
      expect(states.at(-1)).toEqual({ mode: "stalled", error: "replica rpc failed" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("repeatedly-failing in-pull recovery with a network-shaped underlying error never stalls", async () => {
    vi.useFakeTimers();
    try {
      const replica = fakeReplica({
        applyChanges: vi.fn(async () => ({ status: "needs-bootstrap" as const })),
      });
      const fetchJson = vi.fn(async (path: string) => {
        if (path === "/api/sync/snapshot") throw new TypeError("Failed to fetch");
        return feed();
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // recovery failure 1

      // Advance well past the point where a stall-shaped failure run would
      // have crossed STALL_AFTER_FAILURES (3).
      for (let i = 0; i < 8; i += 1) {
        await vi.advanceTimersByTimeAsync(RETRY_MAX_MS);
      }

      expect(states.some((s) => s.mode === "stalled")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("recovery-failed re-reports ready once a later pull succeeds", async () => {
    // Before the fix, a recovery-failed report that never crossed the stall
    // threshold left reportedNonReady false, so a later successful pull's
    // noteSuccess never re-emitted "ready" -- the banner and stale
    // replicaState stuck around forever despite a healthy replica.
    const replica = fakeReplica({
      applyChanges: vi.fn()
        .mockResolvedValueOnce({ status: "needs-bootstrap" })
        .mockResolvedValue({ status: "applied", cursor: 5 }),
    });
    let snapshotShouldFail = true;
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") {
        if (snapshotShouldFail) throw new Error("snapshot offline");
        return SNAP;
      }
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();
    expect(states.at(-1)).toEqual({ mode: "recovery-failed", error: "snapshot offline" });

    snapshotShouldFail = false;
    await sync.start(); // next pull attempt: recovery succeeds this time
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });
});

describe("resetLocalData", () => {
  test("resetLocalData flushes, resets and bootstraps", async () => {
    const batch: PendingBatch = {
      id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false,
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
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start();

    await sync.resetLocalData({ discardPending: false });

    expect(posted).toEqual(["b-1"]);
    expect(commitRecovery).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("resetLocalData without discardPending surfaces a blocked reset when flush fails", async () => {
    const batch: PendingBatch = {
      id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false,
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
    const queue = { pause: vi.fn(), resume: vi.fn() };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();

    let caught: unknown;
    try {
      await sync.resetLocalData({ discardPending: false });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ResetBlockedError);
    expect((caught as ResetBlockedError).pending).toBe(1);
    // The original flush failure survives as `cause`: a transport failure and
    // a server rejection must stay distinguishable behind one message.
    expect((caught as ResetBlockedError).cause).toBeInstanceOf(Error);
    expect(((caught as ResetBlockedError).cause as Error).message)
      .toBe("flush offline");
    expect(replica.calls).toContain("abortRecovery");
    expect(replica.calls).not.toContain("commitRecovery");
    expect(snapshotCalls).toBe(0);
    // A blocked reset is a refusal, not an outage: the database is intact and
    // delivery must be handed back so the flush the user is being asked about
    // can still succeed on its own.
    expect(queue.resume.mock.calls).toEqual([["recovery"]]);
  });

  test("resetLocalData succeeding after a failed doStart reports ready and re-enables pulls", async () => {
    // init succeeds but schema recovery's snapshot fails: doStart returns
    // early, `started` never gets set, and the replica is left recovery-failed
    // with pulls permanently no-op'd until something re-enables them.
    const batch: PendingBatch = {
      id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false,
    };
    const replica = fakeReplica({}, { schemaMismatch: true, pendingBatches: [batch] });
    let snapshotShouldFail = true;
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") return { ok: true };
      if (path === "/api/sync/snapshot") {
        if (snapshotShouldFail) throw new Error("snapshot offline");
        return SNAP;
      }
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();
    expect(states.at(-1)).toEqual({ mode: "recovery-failed", error: "snapshot offline" });

    snapshotShouldFail = false;
    await sync.resetLocalData({ discardPending: true });
    expect(states.at(-1)).toEqual({ mode: "ready" });

    const callsBefore = fetchJson.mock.calls.length;
    sync.onSeq((999 as SyncSeq)); // cursor is now SNAP.seq (5); a higher seq must trigger a pull
    await sync.idle();
    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=5");
    sync.stop();
  });

  test("resetLocalData succeeding from recovery-failed reported via a failed runRecovery also ends ready", async () => {
    // Here `started` was already true (init succeeded before the pull's
    // needs-bootstrap recovery failed); a reset must still force-report ready
    // rather than rely on a previously-reported stall to unlock it.
    const batch: PendingBatch = {
      id: (8 as PendingRowId), batch_id: bid("b-8"), ops: [{ op: "delete", uid: uid("uid_a8") }], poisoned: false,
    };
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
      prepareRecovery: async () => ({ token: "lease-feed", batches: [batch] }),
    });
    let opsShouldFail = true;
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") {
        if (opsShouldFail) throw new Error("feed flush offline");
        return { ok: true };
      }
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();
    expect(states.at(-1)).toEqual({ mode: "recovery-failed", error: "feed flush offline" });

    opsShouldFail = false;
    await sync.resetLocalData({ discardPending: true });
    expect(states.at(-1)).toEqual({ mode: "ready" });
    sync.stop();
  });

  test("resetLocalData rejects immediately when poison owns recovery, without touching the queue or lease", async () => {
    const replica = fakeReplica();
    let signalPoisonPending: () => void = () => undefined;
    const queue = {
      pause: vi.fn(),
      resume: vi.fn(),
      onPoisonPending: (listener: () => void) => {
        signalPoisonPending = listener;
        return () => undefined;
      },
    };
    const fetchJson = vi.fn(async () => feed());
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();
    signalPoisonPending();

    await expect(sync.resetLocalData({ discardPending: true }))
      .rejects.toThrow("rejected-batch repair in progress");

    expect(replica.calls).not.toContain("prepareRecovery");
    expect(queue.pause).not.toHaveBeenCalled();
  });

  test("resetLocalData does not resume the queue when poison now owns recovery", async () => {
    const replica = fakeReplica();
    let signalPoisonPending: () => void = () => undefined;
    const queue = {
      pause: vi.fn(),
      resume: vi.fn(),
      onPoisonPending: (listener: () => void) => {
        signalPoisonPending = listener;
        return () => undefined;
      },
    };
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") {
        // poison observed mid-reset, after the entry guard already passed
        signalPoisonPending();
        return SNAP;
      }
      return feed();
    });
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();

    await sync.resetLocalData({ discardPending: true });

    expect(queue.resume).not.toHaveBeenCalled();
  });

  test("resetLocalData follows the shared queue/lease/flush/snapshot/commit trace", async () => {
    const trace: string[] = [];
    const batches: PendingBatch[] = [
      { id: (1 as PendingRowId), batch_id: bid("b-1"), ops: [{ op: "delete", uid: uid("uid_a1") }], poisoned: false },
      { id: (2 as PendingRowId), batch_id: bid("b-2"), ops: [{ op: "delete", uid: uid("uid_a2") }], poisoned: true },
      { id: (3 as PendingRowId), batch_id: bid("b-3"), ops: [{ op: "delete", uid: uid("uid_a3") }], poisoned: false },
    ];
    const replica = fakeReplica({
      prepareRecovery: async () => {
        trace.push("prepare lease");
        return { token: "lease-reset", batches };
      },
      commitRecovery: async (token, input) => {
        expect(token).toBe("lease-reset");
        expect(input).toEqual({ kind: "reset", snapshot: { ...SNAP, seq: 42 } });
        trace.push("compare final durable rows");
        trace.push("reset plus snapshot");
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
        return { ...SNAP, seq: 42 };
      }
      return feed();
    });
    const queue = {
      pause: () => { trace.push("pause queue"); },
      resume: () => { trace.push("resume queue"); },
    };
    const { states, onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();
    trace.length = 0; // start's own catch-up is not what this test pins

    await sync.resetLocalData({ discardPending: false });

    // the same lifecycle the schema/feed traces above assert, with the poisoned
    // row skipped by the shared flush
    expect(trace).toEqual([
      "pause queue",
      "prepare lease",
      "flush b-1",
      "flush b-3",
      "fetch snapshot",
      "compare final durable rows",
      "reset plus snapshot",
      "release lease",
      "resume queue",
    ]);
    expect(states.at(-1)).toEqual({ mode: "ready" });
  });

  test("resetLocalData waits for an in-flight guarded feed before taking the lease", async () => {
    let releaseFeed!: () => void;
    const feedGate = new Promise<void>((resolve) => { releaseFeed = resolve; });
    let changeCalls = 0;
    let prepareCalls = 0;
    const replica = fakeReplica({
      prepareRecovery: async () => {
        prepareCalls += 1;
        return { token: "lease-reset", batches: [] };
      },
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") return SNAP;
      changeCalls += 1;
      if (changeCalls === 2) await feedGate;
      return feed({ next_since: (6 as SyncSeq), latest_seq: (6 as SyncSeq) });
    });
    const { onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });
    await sync.start();

    sync.onSeq((9 as SyncSeq));
    await vi.waitFor(() => { expect(changeCalls).toBe(2); });
    const reset = sync.resetLocalData({ discardPending: true });
    // prepareRecovery is called synchronously once the awaits ahead of it are
    // done, so a missing wait would already show up here as prepareCalls === 1
    await Promise.resolve();
    expect(prepareCalls).toBe(0);

    releaseFeed();
    await reset;
    expect(prepareCalls).toBe(1);
  });

  test("a failed reset snapshot aborts the lease and leaves the report to the caller", async () => {
    const replica = fakeReplica({
      prepareRecovery: async () => ({ token: "lease-reset", batches: [] }),
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") throw new Error("snapshot offline");
      return feed();
    });
    const queue = { pause: vi.fn(), resume: vi.fn() };
    const { states, onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();
    const statesAfterStart = states.length;

    await expect(sync.resetLocalData({ discardPending: true }))
      .rejects.toThrow("snapshot offline");

    expect(replica.calls).toContain("abortRecovery");
    expect(replica.calls).not.toContain("commitRecovery");
    expect(queue.resume.mock.calls).toEqual([["recovery"]]);
    // A manual reset reports through its own caller (SyncProvider's
    // reset-failed), never through the coordinator's recovery-failed mode:
    // otherwise a reset the user asked for would also raise a stall banner.
    expect(states.length).toBe(statesAfterStart);
  });

  test("a failed reset commit aborts, resumes, and keeps the pre-reset cursor", async () => {
    const trace: string[] = [];
    const replica = fakeReplica({
      prepareRecovery: async () => {
        trace.push("prepare");
        return { token: "lease-reset", batches: [] };
      },
      commitRecovery: async () => {
        trace.push("compare");
        throw new Error("pending rows changed during recovery");
      },
      abortRecovery: async () => { trace.push("abort"); },
    });
    const fetchJson = vi.fn(async (path: string) =>
      path === "/api/sync/snapshot" ? { ...SNAP, seq: 42 } : feed());
    const queue = {
      pause: () => { trace.push("pause"); },
      resume: () => { trace.push("resume"); },
    };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();
    trace.length = 0;

    await expect(sync.resetLocalData({ discardPending: true }))
      .rejects.toThrow("pending rows changed during recovery");

    expect(trace).toEqual(["pause", "prepare", "compare", "abort", "resume"]);
    // the cursor only advances with a committed snapshot: a later nudge still
    // asks from where the retained database actually is
    sync.onSeq((999 as SyncSeq));
    await sync.idle();
    expect(fetchJson.mock.calls.at(-1)?.[0]).toBe("/api/sync/changes?since=5");
    sync.stop();
  });
});

describe("the delivery barrier", () => {
  // Pins the shared recovery protocol rather than any one entrant: whoever owns
  // delivery resumption releases the barrier exactly once on the way out,
  // whether the lifecycle committed or threw. Poison repair is the deliberate
  // exception (the provider resumes after deleting the durable row) and has its
  // own tests above.
  type BarrierEntrant = "schema recovery" | "feed rebootstrap" | "manual reset";

  async function runBarrierEntrant(
    entrant: BarrierEntrant, snapshotFails: boolean,
  ): Promise<{ pause: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }> {
    const replica = fakeReplica(
      entrant === "feed rebootstrap"
        ? {
          applyChanges: vi.fn()
            .mockResolvedValueOnce({ status: "needs-bootstrap" })
            .mockResolvedValue({ status: "applied", cursor: 5 }),
        }
        : {},
      entrant === "schema recovery" ? { schemaMismatch: true } : {},
    );
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/sync/snapshot") {
        if (snapshotFails) throw new Error("snapshot offline");
        return SNAP;
      }
      return feed();
    });
    const queue = { pause: vi.fn(), resume: vi.fn() };
    const { onState } = collector();
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState, queue,
    });
    await sync.start();
    if (entrant === "manual reset") {
      await sync.resetLocalData({ discardPending: true })
        .catch(() => undefined);
    }
    sync.stop();
    return queue;
  }

  test.each([
    ["schema recovery", false], ["schema recovery", true],
    ["feed rebootstrap", false], ["feed rebootstrap", true],
    ["manual reset", false], ["manual reset", true],
  ] as const)(
    "%s releases the delivery barrier exactly once (snapshot fails: %s)",
    async (entrant: BarrierEntrant, snapshotFails: boolean) => {
      const queue = await runBarrierEntrant(entrant, snapshotFails);

      expect(queue.pause).toHaveBeenCalledWith("recovery");
      expect(queue.resume.mock.calls).toEqual([["recovery"]]);
    });
});

describe("stop()", () => {
  test("stop() clears the pending retry timer and prevents further scheduling", async () => {
    vi.useFakeTimers();
    try {
      const replica = fakeReplica();
      const fetchJson = vi.fn(async () => { throw new Error("changes offline"); });
      const { onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // failure 1: a retry timer is now scheduled
      const callsBeforeStop = fetchJson.mock.calls.length;

      sync.stop();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * 2);

      expect(fetchJson.mock.calls.length).toBe(callsBeforeStop);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("corruption rebuilds", () => {
  // A corrupt replica is a corrupt CACHE: everything in it but the pending
  // queue can be re-fetched, and runRecovery flushes that queue before it
  // touches the database. So corruption is a reason to rebuild, not a stall to
  // show the user.
  const CORRUPT = () => new ReplicaError(
    "SQLITE_CORRUPT_VTAB: sqlite3 result code 267: database disk image is malformed",
  );

  test("a corruption-shaped pull failure rebuilds the schema instead of stalling", async () => {
    const warn = quietWarn();
    const applyChanges = vi.fn()
      .mockRejectedValueOnce(CORRUPT())
      .mockResolvedValue({ status: "applied", cursor: 9 });
    const commitRecovery = vi.fn(async () => undefined);
    const replica = fakeReplica({ applyChanges, commitRecovery });
    const snap = { ...SNAP, seq: 9 };
    const fetchJson = vi.fn(async (path: string) =>
      path === "/api/sync/snapshot" ? snap : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }));
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();

    // the schema-rebuilding kind: a "rebase" would run DELETE FROM blocks over
    // the same corrupt FTS index and fail the same way
    expect(commitRecovery).toHaveBeenCalledWith("lease-1", { kind: "reset", snapshot: snap });
    expect(states.map((s) => s.mode)).not.toContain("stalled");
    expect(states.map((s) => s.mode)).not.toContain("recovery-failed");
    expect(states.at(-1)).toEqual({ mode: "ready" });
    expect(logged(warn, "local database is corrupt")).toBe(1);
  });

  test("corruption that survives one rebuild is a stall, not a rebuild loop", async () => {
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const applyChanges = vi.fn().mockRejectedValue(CORRUPT());
      const commitRecovery = vi.fn(async () => undefined);
      const replica = fakeReplica({ applyChanges, commitRecovery });
      const fetchJson = vi.fn(async (path: string) =>
        path === "/api/sync/snapshot" ? SNAP : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }));
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (STALL_AFTER_FAILURES + 1));

      expect(commitRecovery).toHaveBeenCalledTimes(1);
      expect(states).toContainEqual({
        mode: "stalled",
        error: "SQLITE_CORRUPT_VTAB: sqlite3 result code 267: database disk image is malformed",
      });
      expect(logged(warn, "local database is corrupt")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a feed re-bootstrap whose snapshot apply hits corruption escalates to a schema rebuild", async () => {
    const warn = quietWarn();
    const kinds: string[] = [];
    const commitRecovery = vi.fn(async (_token: string, input: { kind: string }) => {
      kinds.push(input.kind);
      if (input.kind === "rebase") throw CORRUPT();
    });
    const replica = fakeReplica({
      applyChanges: vi.fn()
        .mockResolvedValueOnce({ status: "needs-bootstrap" })
        .mockResolvedValue({ status: "applied", cursor: 9 }),
      commitRecovery: commitRecovery as unknown as Replica["commitRecovery"],
    });
    const fetchJson = vi.fn(async (path: string) =>
      path === "/api/sync/snapshot" ? SNAP : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }));
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();

    expect(kinds).toEqual(["rebase", "reset"]);
    expect(states.map((s) => s.mode)).not.toContain("recovery-failed");
    expect(states.at(-1)).toEqual({ mode: "ready" });
    expect(logged(warn, "local database is corrupt")).toBe(1);
  });

  test("a fresh corruption posts a diagnostics report gathered before the rebuild", async () => {
    // The reset drops the tables, so whatever the database can say about the
    // corruption has to be read first; the POST itself is fire-and-forget.
    const warn = quietWarn();
    const report = { sqliteVersion: "3.53.0", quickCheck: ["ok"],
      integrity: { blocks_fts: "malformed", pages_fts: "ok" },
      counts: { pages: 1, blocks: 2, pending_ops: 0,
                pages_fts_docsize: 1, blocks_fts_docsize: 1 },
      meta: { cursor: "5", generation: "gen-1", schema_version: "v" } };
    const applyChanges = vi.fn()
      .mockRejectedValueOnce(CORRUPT())
      .mockResolvedValue({ status: "applied", cursor: 9 });
    const replica = fakeReplica({
      applyChanges, diagnostics: async () => { replica.calls.push("diagnostics"); return report; },
    });
    const posted: { path: string; body: unknown }[] = [];
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/client/diagnostics") {
        posted.push({ path, body: JSON.parse(String(init?.body)) });
        throw new Error("diagnostics endpoint down"); // must not matter
      }
      return path === "/api/sync/snapshot" ? SNAP : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) });
    });
    const { states, onState } = collector();
    const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

    await sync.start();
    await Promise.resolve(); // let the fire-and-forget POST settle

    expect(replica.calls.indexOf("diagnostics"))
      .toBeLessThan(replica.calls.indexOf("commitRecovery"));
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({
      kind: "replica-corruption",
      error: expect.stringContaining("SQLITE_CORRUPT_VTAB") as unknown,
      report,
    });
    expect(states.at(-1)).toEqual({ mode: "ready" });
    expect(logged(warn, "local database is corrupt")).toBe(1);
    // a failed POST is logged and swallowed
    expect(warn).toHaveBeenCalledWith(
      "replica: could not post diagnostics",
      expect.objectContaining({ message: "diagnostics endpoint down" }));
  });

  test("a rebuild whose snapshot fetch fails is still available to the retry", async () => {
    // The once-per-session budget is spent on a rebuild that HAPPENED, not on
    // one that was attempted: a transient snapshot failure (the flaky link the
    // corruption arrived on) must not reinstate the stall banner.
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const applyChanges = vi.fn()
        .mockRejectedValueOnce(CORRUPT())
        .mockRejectedValueOnce(CORRUPT())
        .mockResolvedValue({ status: "applied", cursor: 9 });
      const commitRecovery = vi.fn(async () => undefined);
      const replica = fakeReplica({ applyChanges, commitRecovery });
      let snapshots = 0;
      const fetchJson = vi.fn(async (path: string) => {
        if (path === "/api/sync/snapshot") {
          snapshots += 1;
          if (snapshots === 1) throw new Error("snapshot offline");
          return SNAP;
        }
        return feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) });
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // corruption -> reset attempt -> snapshot fails -> retry armed
      await vi.advanceTimersByTimeAsync(RETRY_BASE_MS);

      expect(snapshots).toBe(2);
      expect(commitRecovery).toHaveBeenCalledTimes(1);
      expect(states.map((s) => s.mode)).not.toContain("stalled");
      expect(states.at(-1)).toEqual({ mode: "ready" });
      expect(logged(warn, "local database is corrupt")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("window strikes", () => {
  // The sibling of the corruption self-heal above, for the general case: a
  // window that throws for a reason nothing whitelisted (a NOT NULL/CHECK
  // violation from a malformed feed, a bug in upsertBlock) used to roll back,
  // leave the cursor in place, and be refetched with growing backoff forever
  // until the user pressed "Reset local data". apply.ts still throws;
  // replicaSync decides what to do about the WINDOW_STRIKES-th identical
  // throw.
  const UNAPPLIABLE_MSG =
    "SQLITE_CONSTRAINT_NOTNULL: sqlite3 result code 1299: " +
    "NOT NULL constraint failed: blocks.text";
  const UNAPPLIABLE = () => new ReplicaError(UNAPPLIABLE_MSG);

  /** Fails `n` times with the same error, then applies cleanly. */
  const failingApply = (n: number, error: () => unknown) => {
    const mock = vi.fn();
    for (let i = 0; i < n; i += 1) mock.mockRejectedValueOnce(error());
    return mock.mockResolvedValue({ status: "applied", cursor: 9 });
  };

  test("a window that fails identically WINDOW_STRIKES times rebases before the stall banner", async () => {
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const applyChanges = failingApply(WINDOW_STRIKES, UNAPPLIABLE);
      const replica = fakeReplica({ applyChanges });
      // spy rather than replace, so the fake keeps recording the call order
      const commitRecovery = vi.spyOn(replica, "commitRecovery");
      const posted: unknown[] = [];
      const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
        if (path === "/api/client/diagnostics") {
          posted.push(JSON.parse(String(init?.body)));
          return undefined;
        }
        return path === "/api/sync/snapshot"
          ? SNAP : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) });
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start(); // failure 1
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS); // failures 2..N, then the rebase
      await Promise.resolve(); // let the fire-and-forget POST settle

      // a rebase, not a reset: nothing says the schema or the FTS index is bad,
      // and a rebase keeps the pending queue rows
      expect(commitRecovery)
        .toHaveBeenCalledWith("lease-1", { kind: "rebase", snapshot: SNAP, acked: [] });
      expect(commitRecovery).toHaveBeenCalledTimes(1);
      expect(posted).toEqual([expect.objectContaining({
        kind: "window-unappliable",
        error: UNAPPLIABLE_MSG,
      })]);
      // the report is gathered and sent before the rebase discards the window
      expect(replica.calls.indexOf("diagnostics"))
        .toBeLessThan(replica.calls.indexOf("commitRecovery"));
      expect(states.map((s) => s.mode)).not.toContain("stalled");
      expect(states.at(-1)).toEqual({ mode: "ready" });
      expect(warn).toHaveBeenCalledWith(
        "replica: a changes window will not apply, re-snapshotting past it",
        expect.objectContaining({ message: UNAPPLIABLE_MSG }));
      expect(logged(warn, "re-snapshotting")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("window failures with different messages never accumulate into a rebase", async () => {
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const applyChanges = vi.fn();
      for (let i = 0; i < STALL_AFTER_FAILURES + 2; i += 1) {
        applyChanges.mockRejectedValueOnce(
          new ReplicaError(`${UNAPPLIABLE_MSG} (row ${i})`));
      }
      const commitRecovery = vi.fn(async () => undefined);
      const replica = fakeReplica({ applyChanges, commitRecovery });
      const fetchJson = vi.fn(async (path: string) =>
        path === "/api/sync/snapshot" ? SNAP : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) }));
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (STALL_AFTER_FAILURES + 2));

      expect(commitRecovery).not.toHaveBeenCalled();
      expect(logged(warn, "re-snapshotting")).toBe(0);
      expect(fetchJson.mock.calls.map(([path]) => path))
        .not.toContain("/api/client/diagnostics");
      expect(states).toContainEqual({
        mode: "stalled", error: expect.stringContaining("row") as unknown,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("identical window failures at moving cursors never accumulate into a rebase", async () => {
    vi.useFakeTimers();
    try {
      // Each pull applies one window (moving the cursor) and then fails on the
      // next one, so no two failures share a cursor.
      let call = 0;
      const applyChanges = vi.fn(async (f: Changes) => {
        call += 1;
        if (call % 2 === 1) return { status: "applied", cursor: f.next_since };
        throw UNAPPLIABLE();
      });
      const commitRecovery = vi.fn(async () => undefined);
      const replica = fakeReplica({
        applyChanges: applyChanges as unknown as Replica["applyChanges"],
        commitRecovery,
      });
      const fetchJson = vi.fn(async (path: string) => {
        if (path === "/api/sync/snapshot") return SNAP;
        const since = Number(path.split("=")[1]);
        return feed({ next_since: (since + 1 as SyncSeq), latest_seq: (999 as SyncSeq) });
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (STALL_AFTER_FAILURES + 2));

      expect(commitRecovery).not.toHaveBeenCalled();
      expect(states).toContainEqual({ mode: "stalled", error: UNAPPLIABLE_MSG });
    } finally {
      vi.useRealTimers();
    }
  });

  test("network and API failures never count toward the window strikes", async () => {
    vi.useFakeTimers();
    try {
      const replica = fakeReplica({ commitRecovery: vi.fn(async () => undefined) });
      const fetchJson = vi.fn(async () => {
        throw new ApiError(503, "/api/sync/changes");
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (WINDOW_STRIKES + 2));

      expect(replica.calls).not.toContain("commitRecovery");
      expect(states.some((s) => s.mode === "stalled")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a second run of identical window failures stalls instead of rebasing again", async () => {
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const applyChanges = failingApply(WINDOW_STRIKES, UNAPPLIABLE);
      // one clean window (the mockResolvedValue above) is consumed by the pull
      // that follows the rebase; every later pull fails the same way again
      const commitRecovery = vi.fn(async () => undefined);
      const replica = fakeReplica({ applyChanges, commitRecovery });
      const fetchJson = vi.fn(async (path: string) =>
        path === "/api/sync/snapshot" ? SNAP : feed());
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS); // strikes -> one rebase -> clean window
      expect(commitRecovery).toHaveBeenCalledTimes(1);
      expect(states.some((s) => s.mode === "stalled")).toBe(false);

      applyChanges.mockRejectedValue(UNAPPLIABLE());
      sync.onSeq((99 as SyncSeq)); // a fresh nudge starts the same failure run over
      await sync.idle();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (WINDOW_STRIKES + 2));

      // the session's one automatic rebase is spent: the user now sees the
      // stall banner, which is the point at which a feed bug should be visible
      expect(commitRecovery).toHaveBeenCalledTimes(1);
      expect(states).toContainEqual({ mode: "stalled", error: UNAPPLIABLE_MSG });
      expect(logged(warn, "re-snapshotting")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a strikes-rebase whose snapshot fetch fails is still available to the retry", async () => {
    // Mirrors the corruption budget rule: the once-per-session rebase is spent
    // when a rebase HAPPENS, not when one is attempted.
    const warn = quietWarn();
    vi.useFakeTimers();
    try {
      const applyChanges = failingApply(WINDOW_STRIKES + 1, UNAPPLIABLE);
      const commitRecovery = vi.fn(async () => undefined);
      const replica = fakeReplica({ applyChanges, commitRecovery });
      let snapshots = 0;
      const fetchJson = vi.fn(async (path: string) => {
        if (path === "/api/sync/snapshot") {
          snapshots += 1;
          if (snapshots === 1) throw new Error("snapshot offline");
          return SNAP;
        }
        return path === "/api/client/diagnostics"
          ? undefined : feed({ next_since: (9 as SyncSeq), latest_seq: (9 as SyncSeq) });
      });
      const { states, onState } = collector();
      const sync = createReplicaSync({ replica, fetchJson, clientId: CID, onState });

      await sync.start();
      await vi.advanceTimersByTimeAsync(RETRY_MAX_MS * (WINDOW_STRIKES + 2));

      expect(snapshots).toBe(2);
      expect(logged(warn, "re-snapshotting")).toBe(2);
      expect(commitRecovery).toHaveBeenCalledTimes(1);
      expect(states.map((s) => s.mode)).not.toContain("stalled");
      expect(states.at(-1)).toEqual({ mode: "ready" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("acks held across a flush and rebase", () => {
  const leased = (id: number, poisoned = false): PendingBatch => ({
    id: id as PendingRowId, batch_id: bid(`b-${id}`),
    ops: [{ op: "delete", uid: uid(`uid_${id}`) }], poisoned,
  });
  const batchIdOf = (init?: RequestInit): string =>
    (JSON.parse(String(init?.body)) as { batch_id: string }).batch_id;

  test("the recovery flush hands each ack to the rebase commit, a stored ack without seq as null", async () => {
    const commitRecovery = vi.fn(async () => undefined);
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
      prepareRecovery: async () => ({
        token: "lease-1", batches: [leased(1), leased(2, true), leased(3)],
      }),
      commitRecovery,
    });
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/ops") {
        return batchIdOf(init) === "b-1"
          ? { ok: true, ts: 1, applied: 1, seq: 11 }
          : { ok: true, ts: 1, applied: 1 };
      }
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState: collector().onState,
    });

    await sync.start();

    expect(commitRecovery).toHaveBeenCalledWith("lease-1", {
      kind: "rebase", snapshot: SNAP,
      acked: [{ id: 1, batch_id: bid("b-1"), seq: 11 }, { id: 3, batch_id: bid("b-3"), seq: null }],
    });
  });

  test("a flush preempted by a poison repair hands the acks it got to the poison rebase's commit", async () => {
    const commitRecovery = vi.fn(async () => undefined);
    const abortRecovery = vi.fn(async () => undefined);
    const batches = [leased(1), leased(2)];
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
      prepareRecovery: vi.fn()
        .mockResolvedValueOnce({ token: "normal-lease", batches })
        .mockResolvedValueOnce({ token: "poison-lease", batches }),
      commitRecovery,
      abortRecovery,
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
    const posted: string[] = [];
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/ops") {
        posted.push(batchIdOf(init));
        // a later batch's rejection lands while this one is in flight
        signalPoisonPending();
        return { ok: true, ts: 1, applied: 1, seq: 8 };
      }
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState: collector().onState, queue,
    });

    await sync.start();
    await sync.rebaseAuthoritative("poison");

    expect(posted).toEqual(["b-1"]);
    expect(abortRecovery).toHaveBeenCalledWith("normal-lease");
    expect(commitRecovery).toHaveBeenCalledOnce();
    expect(commitRecovery).toHaveBeenCalledWith("poison-lease", {
      kind: "rebase", snapshot: SNAP, acked: [{ id: 1, batch_id: bid("b-1"), seq: 8 }],
    });
  });

  test("a commit takes the held acks, so a later rebase passes none of them", async () => {
    const commitRecovery = vi.fn(async () => undefined);
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
      prepareRecovery: vi.fn()
        .mockResolvedValueOnce({ token: "lease-1", batches: [leased(1)] })
        .mockResolvedValueOnce({ token: "lease-2", batches: [] }),
      commitRecovery,
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") return { ok: true, ts: 1, applied: 1, seq: 8 };
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState: collector().onState,
    });

    await sync.start();
    await sync.rebaseAuthoritative("poison");

    expect(commitRecovery.mock.calls.map(
      (call) => (call as unknown[])[1] as { acked?: unknown }).map((input) => input.acked))
      .toEqual([[{ id: 1, batch_id: bid("b-1"), seq: 8 }], []]);
  });

  test("a commit that fails hands its acks to the next commit", async () => {
    const commitRecovery = vi.fn()
      .mockRejectedValueOnce(new Error("snapshot apply failed"))
      .mockResolvedValue(undefined);
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
      prepareRecovery: vi.fn()
        .mockResolvedValueOnce({ token: "lease-1", batches: [leased(1)] })
        .mockResolvedValueOnce({ token: "lease-2", batches: [leased(1)] }),
      commitRecovery,
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") return { ok: true, ts: 1, applied: 1, seq: 8 };
      if (path === "/api/sync/snapshot") return SNAP;
      return feed();
    });
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState: collector().onState,
    });

    await sync.start();
    await sync.rebaseAuthoritative("poison");

    expect(commitRecovery).toHaveBeenLastCalledWith("lease-2", {
      kind: "rebase", snapshot: SNAP, acked: [{ id: 1, batch_id: bid("b-1"), seq: 8 }],
    });
    sync.stop(); // the failed pull armed a retry
  });
});

describe("pending batches a payload already holds", () => {
  const row = (id: number, poisoned = false): PendingBatch => ({
    id: id as PendingRowId, batch_id: bid(`b-${id}`),
    ops: [{ op: "delete", uid: uid(`uid_${id}`) }], poisoned,
  });
  const dropped = (id: number, skipped: SkippedOp[] = []): DroppedBatch => ({
    id: id as PendingRowId, batch_id: bid(`b-${id}`), seq: 9 as SyncSeq, skipped,
  });
  const SKIP: SkippedOp = {
    index: 0, op: "delete", uid: uid("uid_1"), reason: "block_not_found",
    note_page: null,
  };
  const queueSpy = () => ({
    pause: vi.fn(), resume: vi.fn(), settleCommitted: vi.fn(),
  });

  test("a pull names the head of its non-poisoned pending batches", async () => {
    const replica = fakeReplica({
      pendingBatches: async () => [row(1, true), row(2), row(3)],
    });
    const fetchJson = vi.fn(async () => feed());
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState: collector().onState,
    });
    await sync.start();
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/sync/changes?since=5&pending=b-2&pending=b-3");
  });

  test("a pull names at most PENDING_IDS_CAP of them, oldest first", async () => {
    const rows = Array.from({ length: PENDING_IDS_CAP + 5 }, (_, i) => row(i + 1));
    const replica = fakeReplica({ pendingBatches: async () => rows });
    const fetchJson = vi.fn(async (_path: string) => feed());
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, onState: collector().onState,
    });
    await sync.start();
    const path = fetchJson.mock.calls[0][0];
    const named = new URLSearchParams(path.split("?")[1]).getAll("pending");
    expect(named).toEqual(rows.slice(0, PENDING_IDS_CAP).map((r) => r.batch_id));
  });

  test("an empty queue names nothing", async () => {
    const fetchJson = vi.fn(async () => feed());
    const sync = createReplicaSync({
      replica: fakeReplica(), fetchJson, clientId: CID, onState: collector().onState,
    });
    await sync.start();
    expect(fetchJson).toHaveBeenCalledWith("/api/sync/changes?since=5");
  });

  test("the pull hands the rows the replica dropped to the queue", async () => {
    const replica = fakeReplica({
      pendingBatches: async () => [row(1), row(2)],
      applyChanges: vi.fn().mockResolvedValueOnce({
        status: "applied", cursor: 5 as SyncSeq, dropped: [dropped(1)],
      }),
    });
    const queue = queueSpy();
    const onSkipped = vi.fn();
    const sync = createReplicaSync({
      replica, fetchJson: vi.fn(async () => feed()), clientId: CID, queue,
      onState: collector().onState,
    });
    sync.onSkipped(onSkipped);
    await sync.start();
    expect(replica.applyChanges).toHaveBeenCalledWith(feed(), [1, 2]);
    expect(queue.settleCommitted).toHaveBeenCalledWith([bid("b-1")]);
    expect(onSkipped).not.toHaveBeenCalled();
  });

  test("a dropped batch whose ack skipped an op bumps resync once, as the ack would", async () => {
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({
        status: "applied", cursor: 5 as SyncSeq,
        dropped: [dropped(1, [SKIP]), dropped(2, [SKIP])],
      }),
    });
    const onSkipped = vi.fn();
    const sync = createReplicaSync({
      replica, fetchJson: vi.fn(async () => feed()), clientId: CID,
      queue: queueSpy(), onState: collector().onState,
    });
    sync.onSkipped(onSkipped);
    await sync.start();
    expect(onSkipped).toHaveBeenCalledTimes(1);
  });

  test("a bootstrap names the pending batches init read and settles those the snapshot holds",
    async () => {
      const replica = fakeReplica({}, {
        empty: true, cursor: 0 as SyncSeq, pendingBatches: [row(1), row(2, true)],
      });
      const snap: Snapshot = {
        ...SNAP, applied_batches: [{ batch_id: bid("b-1"), seq: 4 as SyncSeq, skipped: [SKIP] }],
      };
      const fetchJson = vi.fn(async (path: string) =>
        path.startsWith("/api/sync/snapshot") ? snap : feed());
      const queue = queueSpy();
      const onSkipped = vi.fn();
      const sync = createReplicaSync({
        replica, fetchJson, clientId: CID, queue, onState: collector().onState,
      });
      sync.onSkipped(onSkipped);
      await sync.start();
      expect(fetchJson).toHaveBeenCalledWith(
        "/api/sync/snapshot?pending=b-1", undefined, { timeoutMs: null });
      expect(queue.settleCommitted).toHaveBeenCalledWith([bid("b-1")]);
      expect(onSkipped).toHaveBeenCalledTimes(1);
    });

  test("a poison rebase names no pending batch", async () => {
    const replica = fakeReplica({
      prepareRecovery: async () => ({
        token: "lease-1", batches: [row(1, true), row(2), row(3)],
      }),
    });
    const fetchJson = vi.fn(async (path: string) =>
      path.startsWith("/api/sync/snapshot") ? SNAP : feed());
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, queue: queueSpy(),
      onState: collector().onState,
    });
    await sync.start();
    await sync.rebaseAuthoritative("poison");
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/sync/snapshot", undefined, { timeoutMs: null });
  });

  test("a rebase whose flush got every ack names nothing", async () => {
    const replica = fakeReplica({
      applyChanges: vi.fn().mockResolvedValueOnce({ status: "needs-bootstrap" }),
      prepareRecovery: async () => ({ token: "lease-1", batches: [row(1), row(2)] }),
    });
    const fetchJson = vi.fn(async (path: string) => {
      if (path === "/api/ops") return { ok: true, ts: 1, applied: 1, seq: 7 };
      if (path.startsWith("/api/sync/snapshot")) return SNAP;
      return feed();
    });
    const sync = createReplicaSync({
      replica, fetchJson, clientId: CID, queue: queueSpy(), onState: collector().onState,
    });
    await sync.start();
    expect(fetchJson).toHaveBeenCalledWith(
      "/api/sync/snapshot", undefined, { timeoutMs: null });
  });
});
