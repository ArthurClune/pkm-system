import { expect, test, vi } from "vitest";
import type { Changes } from "../replica/apply";
import { ReplicaUnavailableError } from "../replica/errors";
import { memReplica } from "./memReplica";
import { createReconnectFlow } from "./reconnectFlow";
import { createReplicaSync } from "./replicaSync";
import type { DrainOutcome } from "./opQueue";

/** A changes window with nothing in it: the flapping-link case, where the
 * cursor the replica already holds is the latest the server has. */
const QUIET_FEED: Changes = {
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: 0, latest_seq: 0,
  pages: [], blocks: [], sidebar: [], tombstones: [],
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface FakeReplicaSync {
  start: () => Promise<void>;
  idle: () => Promise<void>;
  appliedVersion: () => number | null;
}

/** A catch-up that finds changes: its feed pull advances appliedVersion. The
 * default, because that is the reconnect a resync exists for. */
function movingReplica(trace: string[]): FakeReplicaSync {
  let version = 7; // not 0: nothing may key off the counter's absolute value
  return {
    start: async () => { trace.push("start"); version += 1; },
    idle: async () => { trace.push("idle"); },
    appliedVersion: () => version,
  };
}

/** A catch-up that finds nothing: one changes pull, cursor unmoved. */
function unmovedReplica(trace: string[]): FakeReplicaSync {
  return {
    start: async () => { trace.push("start"); },
    idle: async () => { trace.push("idle"); },
    appliedVersion: () => 7,
  };
}

function harness(opts: {
  drain?: () => Promise<DrainOutcome>;
  /** Built from the harness's own trace so every step lands in one order. */
  replicaSync?: ((trace: string[]) => FakeReplicaSync) | null;
  mounted?: () => boolean;
} = {}) {
  const trace: string[] = [];
  const drain = opts.drain ?? (async () => {
    trace.push("drain");
    return { status: "drained" as const };
  });
  const replicaSync = opts.replicaSync === undefined
    ? movingReplica(trace)
    : opts.replicaSync?.(trace) ?? null;
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
  let version = 7;
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); version += 1; },
      idle: async () => { t.push("idle"); await feed.promise; },
      appliedVersion: () => version,
    }),
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

test("a reconnect that changed nothing pulls the feed but does not resync "
   + "(pkm-5fak)", async () => {
  // The train symptom: a 2 s blip with an empty queue and nothing on the
  // server costs one changes pull and no view refetch.
  const { flow, trace } = harness({ replicaSync: unmovedReplica });

  await flow.begin();

  expect(trace).toEqual(["drain", "start", "idle"]);
});

test("a stale-views connect resyncs even when nothing moved (pkm-5fak)",
async () => {
  // A first connect flushing a previous page load's leftovers: the views read
  // the server before any of this, and the mount-time catch-up may already
  // have absorbed the flush, so the cursor has nothing left to report.
  const { flow, trace } = harness({ replicaSync: unmovedReplica });

  await flow.begin({ viewsAreStale: true });

  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
});

test("a stale-views connect finished out of band still resyncs (pkm-5fak)",
async () => {
  // The intent carries the staleness, not the call: the queue's own retry is
  // what got the leftovers through, so observeDrain completes this reconnect.
  const blocked = gate();
  const { flow, trace } = harness({
    drain: async () => {
      await blocked.promise;
      return { status: "blocked", reason: "retryable", pending: 1 };
    },
    replicaSync: unmovedReplica,
  });

  const running = flow.begin({ viewsAreStale: true });
  blocked.release();
  await running;

  flow.observeDrain({ status: "drained" });
  await vi.waitFor(() => {
    expect(trace).toEqual(["start", "idle", "resync"]);
  });
});

test("a replica that cannot say whether anything moved still resyncs "
   + "(pkm-5fak)", async () => {
  // appliedVersion() is null for a session with no usable database: there is
  // no cursor to compare, so the reconnect must be treated as a change or an
  // online-only session would never refresh its views again.
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); },
      idle: async () => { t.push("idle"); },
      appliedVersion: () => null,
    }),
  });

  await flow.begin();

  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
});

test("a reconnect resyncs once a pull reports the replica has become unusable "
   + "(pkm-5fak)", async () => {
  // The real replicaSync, not a fake: a mid-session database death is only
  // observable through a pull, and the point of the test is that the real one
  // still reports it. The worker latches its own failed open, so every db()
  // call rejects with it from here on and no cursor comparison is possible.
  let latched: Error | null = null;
  const replica = memReplica({
    pendingBatches: async () => {
      if (latched) throw latched;
      return [];
    },
  });
  const sync = createReplicaSync({
    replica,
    fetchJson: async () => QUIET_FEED,
    clientId: "c1",
    onState: () => undefined,
  });
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); await sync.start(); },
      idle: async () => { t.push("idle"); await sync.idle(); },
      appliedVersion: () => sync.appliedVersion(),
    }),
  });

  // A healthy reconnect over a quiet feed: pulled, nothing to refetch.
  await flow.begin();
  expect(trace).toEqual(["drain", "start", "idle"]);

  latched = new ReplicaUnavailableError("no openable database");
  await flow.begin();

  expect(trace).toEqual([
    "drain", "start", "idle", "drain", "start", "idle", "resync",
  ]);
  sync.stop(); // the failed pull scheduled a backoff retry
});
