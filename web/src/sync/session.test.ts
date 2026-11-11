import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../api/client";
import type { BlockOp } from "../api/ops";
import type { OpBatch, OpsAck } from "../api/payloads";
import { MAX_BLOCK_TEXT_CHARS } from "../grammar/textLimits";
import type { PendingBatch, Replica } from "../replica/client";
import { batchIdOf, clientIdOf, defer, pendingRowIdOf, rawTitleOf, seqOf,
         uidOf } from "../test-helpers";
import type { ClientRuntime, ClientRuntimeDeps } from "./clientRuntime";
import { memReplica } from "./memReplica";
import type { PoisonEvent } from "./opQueue";
import { ResetBlockedError, STALL_AFTER_FAILURES,
         type ReplicaState } from "./replicaSync";
import { createSyncSession, type OutlineHooks, type SyncSession,
         type SyncSessionDeps } from "./session";
import type { WsBatch } from "./socket";
import type { SyncEvent, SyncProblem, SyncStatus } from "./syncState";

// One log for the replica's calls, the runtime's and the fakes', so a test
// can read their relative order.
const trace = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock("./clientRuntime", async (importOriginal) => {
  const real = await importOriginal<typeof import("./clientRuntime")>();
  return {
    ...real,
    createClientRuntime: (deps: ClientRuntimeDeps): ClientRuntime => {
      const runtime = real.createClientRuntime(deps);
      return {
        ...runtime,
        startup: () => {
          trace.log.push("runtime.startup");
          return runtime.startup();
        },
        startupRun: () => runtime.startupRun().then(() => {
          trace.log.push("runtime.startupRun settled");
        }),
        retryFailedRepair: () => {
          trace.log.push("runtime.retryFailedRepair");
          return runtime.retryFailedRepair();
        },
        dispose: () => {
          trace.log.push("runtime.dispose");
          runtime.dispose();
        },
      };
    },
  };
});

const SESSION_CLIENT = clientIdOf("session-test");
const SNAPSHOT = { generation: "g1", seq: 5, pages: [], blocks: [], sidebar: [] };
const feed = (latest: number) => ({
  reset: false, generation: "g1", next_since: latest, latest_seq: latest,
  pages: [], blocks: [], sidebar: [], tombstones: [],
});

const op = (rawUid: string): BlockOp => ({ op: "delete", uid: uidOf(rawUid) });
/** Refused before it is stored: the queue raises a desync for it. */
const overLimit = (): BlockOp => ({
  op: "update_text", uid: uidOf("aaaaaaaa"),
  text: "x".repeat(MAX_BLOCK_TEXT_CHARS + 1),
});
const leftover = (n: number): PendingBatch => ({
  id: pendingRowIdOf(n), batch_id: batchIdOf(`left-${n}`),
  ops: [op("bbbbbbbb")], poisoned: false,
});

/** The replica's calls, logged to the trace. A changes window moves the
 * cursor to its next_since, as the real worker does. */
function loggingReplica(over: Partial<Replica> = {}) {
  const replica = memReplica();
  const { pendingCount, init, poisonedBatches, applySnapshot } = replica;
  const logged: Partial<Replica> = {
    pendingCount: () => { trace.log.push("pendingCount"); return pendingCount(); },
    init: () => { trace.log.push("init"); return init(); },
    poisonedBatches: () => {
      trace.log.push("poisonedBatches");
      return poisonedBatches();
    },
    applySnapshot: (snapshot, ids) => {
      trace.log.push("applySnapshot");
      return applySnapshot(snapshot, ids);
    },
    applyChanges: async (changes) => {
      trace.log.push("applyChanges");
      return { status: "applied", cursor: changes.next_since };
    },
  };
  return Object.assign(replica, logged, over);
}

/** A replica no previous session bootstrapped: start() needs the snapshot. */
const emptyInit: Replica["init"] = async () => {
  trace.log.push("init");
  return { empty: true, cursor: seqOf(0), schemaMismatch: false,
           pendingBatches: [], plainSpaceTitleCanonicalization: false };
};

interface Reported {
  statuses: SyncStatus[];
  modes: ReplicaState[];
  problems: (SyncProblem | undefined)[];
  resyncs: number;
  pending: number[];
  unsent: number[];
  events: SyncEvent[];
}

interface RigOptions {
  replica?: Replica | null;
  /** The server's answer to one POST; the default acks it. */
  answer?: (body: OpBatch) => OpsAck;
  isMounted?: () => boolean;
  retryBaseMs?: number;
  repairSessions?: OutlineHooks["repairSessions"];
  /** The mark intents a previous page load left; none by default. */
  retained?: readonly PoisonEvent[];
}

const sessions: SyncSession[] = [];

function rig(options: RigOptions = {}) {
  const posts: OpBatch[] = [];
  const server = { offline: false, changesFail: false, posts };
  const fetchJson: SyncSessionDeps["fetchJson"] = async (path) => {
    trace.log.push(`fetch ${path.split("?")[0]}`);
    if (server.offline) throw new TypeError("Failed to fetch");
    if (path.startsWith("/api/sync/snapshot")) return SNAPSHOT;
    if (path.startsWith("/api/sync/changes")) {
      if (server.changesFail) throw new ApiError(500, path);
      return feed(5);
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  const post = async (body: OpBatch): Promise<OpsAck> => {
    trace.log.push("post");
    server.posts.push(body);
    return options.answer?.(body)
      ?? { ok: true, ts: 1, applied: body.ops.length, seq: seqOf(6) };
  };
  let minted = 0;
  const reported: Reported = {
    statuses: [], modes: [], problems: [], resyncs: 0, pending: [], unsent: [],
    events: [],
  };
  const outlines = {
    track: vi.fn<OutlineHooks["track"]>(),
    attachReplay: vi.fn<OutlineHooks["attachReplay"]>(),
    repairSessions: vi.fn<OutlineHooks["repairSessions"]>(
      options.repairSessions ?? (async (onStable) => {
        trace.log.push("repairSessions");
        onStable();
      })),
  };
  const session = createSyncSession({
    replica: options.replica === undefined ? loggingReplica() : options.replica,
    clientId: SESSION_CLIENT,
    fetchJson,
    queue: {
      post,
      poisonStore: { read: () => [...(options.retained ?? [])], write: () => undefined },
      newBatchId: () => { minted += 1; return batchIdOf(`batch-${minted}`); },
    },
    retryBaseMs: options.retryBaseMs,
    outlines,
    isMounted: options.isMounted,
    report: {
      status: (s) => { reported.statuses.push(s); },
      replicaState: (s) => { reported.modes.push(s); },
      problem: (p) => { reported.problems.push(p); },
      resync: () => { reported.resyncs += 1; },
      pending: (n) => { reported.pending.push(n); },
      unsentInMemory: (n) => { reported.unsent.push(n); },
      event: (e) => { reported.events.push(e); },
    },
  });
  sessions.push(session);
  return { session, server, reported, outlines };
}

function replicaSyncOf(session: SyncSession) {
  const replicaSync = session.replicaSync;
  if (replicaSync === null) throw new Error("this session has no replica");
  return replicaSync;
}

/** console.error's calls, silenced. */
function errorsLogged(): unknown[][] {
  const logged: unknown[][] = [];
  vi.spyOn(console, "error")
    .mockImplementation((...args: unknown[]) => { logged.push(args); });
  return logged;
}

const turns = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const only = (labels: readonly string[]): string[] =>
  trace.log.filter((entry) => labels.includes(entry));

beforeEach(() => { trace.log.length = 0; });

afterEach(() => {
  sessions.forEach((session) => session.dispose());
  sessions.length = 0;
  vi.restoreAllMocks();
});

describe("the first connect", () => {
  test("a first-connect reconnect().begin() rejection is logged, not left unhandled",
  async () => {
    // reconnectFlow's begin() does not swallow. A non-empty durable queue on
    // first connect drives begin({ viewsAreStale: true }); a throw inside it
    // must not become an unhandled rejection. Thrown from begin's own drain:
    // a replicaSync.start() failure can reach the queue's drain observer
    // first, which swallows it.
    const replica = loggingReplica();
    replica.rows.push(leftover(1));
    const { session } = rig({ replica });
    await session.startup();
    const boom = new Error("drain failed");
    vi.spyOn(session.queue, "drain").mockRejectedValue(boom);
    const logged = errorsLogged();

    await session.onSocketStatus(true);

    expect(logged.some((args) => args[0] === "first-connect reconnect.begin() failed"
      && args.includes(boom))).toBe(true);
  });

  test("a reconnect's begin() rejection is logged, not left unhandled", async () => {
    const { session } = rig();
    await session.startup();
    const logged = errorsLogged();
    // An empty durable queue and a started replica: the first connect skips
    // begin() entirely.
    await session.onSocketStatus(true);
    expect(logged).toEqual([]);

    const boom = new Error("drain failed");
    vi.spyOn(session.queue, "drain").mockRejectedValue(boom);
    await session.onSocketStatus(false);
    await session.onSocketStatus(true);

    expect(logged.some((args) => args[0] === "reconnect.begin() failed"
      && args.includes(boom))).toBe(true);
  });

  test("offline cold start with an empty queue still bootstraps once online",
  async () => {
    // The startup run tried replicaSync.start() before the first connect;
    // offline, its snapshot fetch failed and the failure was swallowed,
    // leaving the replica un-started with an empty durable queue. Only the
    // first connect retries the bootstrap.
    const { session, server } = rig({ replica: loggingReplica({ init: emptyInit }) });
    server.offline = true;
    await session.startup();
    expect(replicaSyncOf(session).hasStarted()).toBe(false);
    const start = vi.spyOn(replicaSyncOf(session), "start");

    server.offline = false;
    await session.onSocketStatus(true);

    expect(start).toHaveBeenCalledTimes(1);
    expect(replicaSyncOf(session).hasStarted()).toBe(true);
    expect(session.replicaState()).toEqual({ mode: "ready" });
  });

  test("online cold start with an already-bootstrapped replica and empty queue " +
  "stays quiet", async () => {
    // A replica the startup run already brought up has nothing left for
    // begin() to do when the queue is empty.
    const { session, reported } = rig();
    await session.startup();
    expect(replicaSyncOf(session).hasStarted()).toBe(true);
    const start = vi.spyOn(replicaSyncOf(session), "start");
    const resyncs = reported.resyncs;

    await session.onSocketStatus(true);

    expect(start).not.toHaveBeenCalled();
    expect(reported.resyncs).toBe(resyncs);
    expect(reported.statuses).toEqual(["connected"]);
  });

  test("each connect retries a failed repair, the first after the startup gate",
  async () => {
    // A startup that failed offline leaves the replica un-started, so the
    // first connect runs the reconnect protocol; it must not ask the runtime
    // until startup has answered.
    const { session, server } = rig({ replica: loggingReplica({ init: emptyInit }) });
    server.offline = true;
    await session.startup();
    server.offline = false;
    const replicaSync = replicaSyncOf(session);
    const realStart = replicaSync.start;
    vi.spyOn(replicaSync, "start").mockImplementation(() => {
      trace.log.push("start");
      return realStart();
    });
    const labels = ["runtime.startupRun settled", "runtime.retryFailedRepair", "start"];
    trace.log.length = 0;

    await session.onSocketStatus(true);
    expect(only(labels)).toEqual(labels);

    trace.log.length = 0;
    await session.onSocketStatus(false);
    await session.onSocketStatus(true);
    expect(only(labels)).toEqual(["runtime.retryFailedRepair", "start"]);
  });

  test("a first connect with pending rows bumps resync even when the pull moved nothing",
  async () => {
    // The views read the server before this session's flush: only the
    // stale-views resync refreshes them, whatever the cursor says.
    const replica = loggingReplica();
    replica.rows.push(leftover(1));
    const { session, server, reported } = rig({ replica });
    await session.startup();
    const before = replicaSyncOf(session).appliedVersion();
    const resyncs = reported.resyncs;

    await session.onSocketStatus(true);

    expect(server.posts.map((p) => p.batch_id)).toEqual([batchIdOf("left-1")]);
    expect(replicaSyncOf(session).appliedVersion()).toBe(before);
    expect(reported.resyncs).toBe(resyncs + 1);
  });

  test("a first connect whose startup outlives dispose starts nothing", async () => {
    const discovery = defer<PoisonEvent[]>();
    const replica = loggingReplica({ poisonedBatches: () => discovery.promise });
    replica.rows.push(leftover(1));
    const { session } = rig({ replica });
    void session.startup();
    const drain = vi.spyOn(session.queue, "drain");
    const connected = session.onSocketStatus(true);

    session.dispose();
    trace.log.length = 0;
    discovery.resolve([]);
    await connected;
    await turns();

    expect(drain).not.toHaveBeenCalled();
    expect(only(["init", "post"])).toEqual([]);
  });

  test("socket status before startup throws", () => {
    const { session, reported } = rig();
    expect(() => session.onSocketStatus(true)).toThrow();
    expect(session.status()).toBe("connecting");
    expect(reported.statuses).toEqual([]);
  });
});

describe("a reload's retained poison mark", () => {
  test("a connect while a reload's poison mark keeps failing leaves recovery " +
       "to the poison claim", async () => {
    const replica = loggingReplica({
      markPoisoned: async () => { throw new Error("mark rpc failed"); },
      applyChanges: async () => {
        trace.log.push("applyChanges");
        return { status: "needs-bootstrap" };
      },
      prepareRecovery: async () => {
        trace.log.push("prepareRecovery");
        return { token: "lease", batches: [...replica.rows] };
      },
    });
    const rejected = leftover(1);
    replica.rows.push(rejected, leftover(2));
    const { session, server, reported } = rig({
      replica,
      retained: [{ id: rejected.id, batch_id: rejected.batch_id,
                   ops: rejected.ops, status: 400, message: "rejected" }],
    });
    await session.startup();
    await session.onSocketStatus(true);
    await turns();

    expect(trace.log).not.toContain("prepareRecovery");
    expect(server.posts).toEqual([]);
    expect(reported.modes.map((m) => m.mode)).not.toContain("recovery-failed");
  });
});

describe("later connects", () => {
  test("a later connect retries the poison repair, then the outline repair, then drains",
  async () => {
    let failNext = true;
    const { session, reported } = rig({
      repairSessions: async (onStable) => {
        trace.log.push("repairSessions");
        if (failNext) {
          failNext = false;
          throw new Error("authoritative read failed");
        }
        onStable();
      },
    });
    await session.startup();
    await session.onSocketStatus(true);
    await session.actions.enqueue([overLimit()]).settled;
    await vi.waitFor(() => expect(session.problem()).toMatchObject({
      kind: "outline-rejected", repair: "failed",
    }));
    const queue = session.queue;
    const realDrain = queue.drain;
    vi.spyOn(queue, "drain").mockImplementation(() => {
      trace.log.push("drain");
      return realDrain();
    });
    trace.log.length = 0;

    await session.onSocketStatus(false);
    await session.onSocketStatus(true);

    expect(only(["runtime.retryFailedRepair", "repairSessions", "drain"]))
      .toEqual(["runtime.retryFailedRepair", "repairSessions", "drain"]);
    expect(reported.problems.at(-1)).toMatchObject({
      kind: "outline-rejected", repair: "repaired",
    });
  });
});

describe("startup", () => {
  test("startup reads the durable count, starts the runtime, then reads the initial pending",
  async () => {
    const { session } = rig();
    const run = session.startup();
    expect(trace.log).toEqual(["pendingCount", "runtime.startup", "pendingCount"]);
    await run;
  });

  test("a second startup returns the first run and starts nothing", async () => {
    const { session } = rig();
    const first = session.startup();
    trace.log.length = 0;
    const second = session.startup();
    expect(second).toBe(first);
    expect(trace.log).toEqual([]);
    await first;
  });

  test("with no replica, startup reports no-replica and the queue delivers online-only",
  async () => {
    const { session, server, reported } = rig({ replica: null });
    expect(session.replicaSync).toBeNull();
    await session.startup();
    expect(reported.modes).toEqual([{ mode: "no-replica" }]);
    expect(session.replicaState()).toEqual({ mode: "no-replica" });
    expect(session.problem()).toBeUndefined();

    await session.onSocketStatus(true);
    const ticket = session.actions.enqueue([op("cccccccc")]);

    await expect(ticket.delivered).resolves.toEqual({ status: "delivered" });
    expect(server.posts).toHaveLength(1);
  });

  test("building the session reports nothing", () => {
    const { reported } = rig();
    expect(reported).toEqual({
      statuses: [], modes: [], problems: [], resyncs: 0, pending: [], unsent: [],
      events: [],
    });
  });
});

describe("liveness", () => {
  test("a desync after unmount starts no repair", async () => {
    let mounted = true;
    const { session, outlines } = rig({ isMounted: () => mounted });
    await session.startup();
    await session.onSocketStatus(true);

    mounted = false;
    await session.actions.enqueue([overLimit()]).settled;
    await turns();

    expect(outlines.repairSessions).not.toHaveBeenCalled();
  });

  test("dispose stops replicaSync, then disposes the queue, then the runtime, once",
  () => {
    const { session } = rig();
    const replicaSync = replicaSyncOf(session);
    const realStop = replicaSync.stop;
    vi.spyOn(replicaSync, "stop").mockImplementation(() => {
      trace.log.push("replicaSync.stop");
      realStop();
    });
    const realDispose = session.queue.dispose;
    vi.spyOn(session.queue, "dispose").mockImplementation(() => {
      trace.log.push("queue.dispose");
      realDispose();
    });

    session.dispose();
    session.dispose();

    expect(trace.log).toEqual(["replicaSync.stop", "queue.dispose", "runtime.dispose"]);
  });
});

describe("the problem fold", () => {
  test("a stalled report raises replica-stalled while connected", async () => {
    const { session, server, reported } = rig({ retryBaseMs: 1 });
    await session.startup();
    await session.onSocketStatus(true);
    server.changesFail = true;
    trace.log.length = 0;

    session.onSeq({ type: "seq", seq: seqOf(99) });

    await vi.waitFor(() => expect(session.problem()).toMatchObject({
      kind: "replica-stalled", reset: "idle",
    }));
    expect(only(["fetch /api/sync/changes"]).length)
      .toBeGreaterThanOrEqual(STALL_AFTER_FAILURES);
    expect(reported.problems.at(-1)).toBe(session.problem());
    expect(session.replicaState()).toMatchObject({ mode: "stalled" });
    expect(reported.events.find((event) => event.type === "replica-state"
      && event.state.mode === "stalled")).toMatchObject({
      prev: "ready", status: "connected",
    });
  });

  test("a problem is reported only when its identity changes", async () => {
    const { session, reported } = rig();
    await session.startup();
    await session.onSocketStatus(true);
    const before = reported.problems.length;

    session.actions.dismissProblem();
    await session.actions.resetReplica();

    // reset-started raises a stalled problem; reset-succeeded clears it.
    expect(reported.problems.slice(before).map((p) => p?.kind))
      .toEqual(["replica-stalled", undefined]);
  });
});

describe("the actions", () => {
  test("an own echo reaches no subscriber", () => {
    const { session } = rig();
    const seen: WsBatch[] = [];
    const off = session.actions.subscribe((batch) => { seen.push(batch); });
    const other = clientIdOf("other-tab");

    session.onBatch({ client_id: SESSION_CLIENT, ts: 1, ops: [] });
    session.onBatch({ client_id: other, ts: 2, ops: [] });
    off();
    session.onBatch({ client_id: other, ts: 3, ops: [] });

    expect(seen.map((batch) => batch.ts)).toEqual([2]);
  });

  test("enqueue tracks the write with the open outlines and replays attach to them",
  async () => {
    const { session, outlines } = rig();
    const ops = [op("dddddddd")];
    const ticket = session.actions.enqueue(ops, ["page", "Inbox"]);
    expect(outlines.track).toHaveBeenCalledWith(ticket, ops);

    session.actions.attachOutlineReplay(ticket, rawTitleOf("Inbox"), []);
    expect(outlines.attachReplay)
      .toHaveBeenCalledWith(ticket, rawTitleOf("Inbox"), []);
    await session.actions.settled();
  });

  test("retryProblem reruns a failed outline repair, and dismiss clears it once repaired",
  async () => {
    let failNext = true;
    const { session, reported } = rig({
      repairSessions: async (onStable) => {
        if (failNext) {
          failNext = false;
          throw new Error("authoritative read failed");
        }
        onStable();
      },
    });
    await session.startup();
    await session.onSocketStatus(true);
    await session.actions.enqueue([overLimit()]).settled;
    await vi.waitFor(() => expect(session.problem()).toMatchObject({
      kind: "outline-rejected", repair: "failed",
    }));
    const resyncs = reported.resyncs;

    await session.actions.retryProblem();
    expect(session.problem()).toMatchObject({
      kind: "outline-rejected", repair: "repaired",
    });
    expect(reported.resyncs).toBe(resyncs + 1);

    session.actions.dismissProblem();
    expect(session.problem()).toBeUndefined();
  });

  test("retryProblem with no runtime and nothing to retry does nothing", async () => {
    const { session } = rig({ replica: null });
    await session.startup();
    await session.actions.retryProblem();
    await session.actions.discardProblem();
    expect(session.problem()).toBeUndefined();
  });

  test("discardProblem only acts on a mark-failed rejected batch", async () => {
    const { session } = rig();
    await session.startup();
    await session.actions.discardProblem();
    expect(session.problem()).toBeUndefined();
  });

  test("a reset blocked by unsent changes is reported with their count", async () => {
    const { session } = rig();
    await session.startup();
    vi.spyOn(replicaSyncOf(session), "resetLocalData")
      .mockRejectedValue(new ResetBlockedError(2));

    await session.actions.resetReplica();

    expect(session.problem()).toMatchObject({
      kind: "replica-stalled", reset: "blocked", pending: 2,
    });
  });

  test("a repaired rejected batch dismisses", async () => {
    const replica = loggingReplica();
    replica.rows.push(leftover(1));
    const { session } = rig({
      replica,
      answer: (body) => {
        throw new ApiError(409, `/api/ops ${body.batch_id}`, "conflict");
      },
    });
    await session.startup();
    await session.onSocketStatus(true);
    await vi.waitFor(() => expect(session.problem()).toMatchObject({
      kind: "rejected-batch", repair: "repaired",
    }));

    session.actions.dismissProblem();

    expect(session.problem()).toBeUndefined();
  });

  test("a reset that fails is reported, and an acknowledged failure dismisses",
  async () => {
    const { session } = rig();
    await session.startup();
    vi.spyOn(replicaSyncOf(session), "resetLocalData")
      .mockRejectedValue(new Error("reset boom"));

    await session.actions.resetReplica();
    expect(session.problem()).toMatchObject({
      kind: "replica-stalled", reset: "failed", resetError: "Error: reset boom",
    });

    session.actions.dismissProblem();
    expect(session.problem()).toBeUndefined();
  });
});
