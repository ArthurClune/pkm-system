import { expect, test, vi } from "vitest";
import type { Changes } from "../replica/apply";
import { ReplicaUnusableError } from "../replica/errors";
import { memReplica } from "./memReplica";
import { createReconnectFlow, type ReconnectFlow } from "./reconnectFlow";
import { createReplicaSync } from "./replicaSync";
import type { DrainOutcome } from "./opQueue";
import { seqOf } from "../test-helpers";

/** A changes window with nothing in it: the flapping-link case, where the
 * cursor the replica already holds is the latest the server has. */
const QUIET_FEED: Changes = {
  reset: false, generation: "gen-1", plain_space_title_canonicalization: false,
  next_since: seqOf(0), latest_seq: seqOf(0),
  pages: [], blocks: [], sidebar: [], tombstones: [],
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

interface FakeReplicaSync {
  start: () => Promise<boolean>;
  idle: () => Promise<void>;
  appliedVersion: () => number | null;
}

/** A catch-up that finds changes: its feed pull advances appliedVersion. The
 * default, because that is the reconnect a resync exists for. */
function movingReplica(trace: string[]): FakeReplicaSync {
  let version = 7; // not 0: nothing may key off the counter's absolute value
  return {
    start: async () => { trace.push("start"); version += 1; return true; },
    idle: async () => { trace.push("idle"); },
    appliedVersion: () => version,
  };
}

/** A catch-up that finds nothing: one changes pull, cursor unmoved. */
function unmovedReplica(trace: string[]): FakeReplicaSync {
  return {
    start: async () => { trace.push("start"); return true; },
    idle: async () => { trace.push("idle"); },
    appliedVersion: () => 7,
  };
}

function harness(opts: {
  drain?: () => Promise<DrainOutcome>;
  /** Built from the harness's own trace so every step lands in one order. */
  replicaSync?: ((trace: string[]) => FakeReplicaSync) | null;
  mounted?: () => boolean;
  /** Runs after the resync is traced, inside the completion's decision. */
  onResync?: (flow: ReconnectFlow) => void;
} = {}) {
  const trace: string[] = [];
  const drain = opts.drain ?? (async () => {
    trace.push("drain");
    return { status: "drained" as const };
  });
  const replicaSync = opts.replicaSync === undefined
    ? movingReplica(trace)
    : opts.replicaSync?.(trace) ?? null;
  const flow: ReconnectFlow = createReconnectFlow({
    queue: { drain: () => drain() },
    replicaSync,
    isMounted: opts.mounted ?? (() => true),
    onResync: () => {
      trace.push("resync");
      opts.onResync?.(flow);
    },
    retryFailedRepair: async () => undefined,
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

test("a reconnect that joins a running completion gets a trailing pull",
async () => {
  const feed = gate();
  let version = 7;
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); return true; },
      idle: async () => { t.push("idle"); await feed.promise; },
      appliedVersion: () => version,
    }),
  });

  const first = flow.begin();
  await vi.waitFor(() => { expect(trace).toContain("idle"); });
  // The first run is past its pull; the second connect's gap holds changes
  // only a pull of its own can find.
  const second = flow.begin();
  await vi.waitFor(() => {
    expect(trace.filter((step) => step === "drain")).toHaveLength(2);
  });
  version += 1;

  feed.release();
  await Promise.all([first, second]);

  expect(trace).toEqual(
    ["drain", "start", "idle", "drain", "start", "idle", "resync"]);

  // The joined run consumed the second intent too: a later stray drain must
  // not resync again.
  flow.observeDrain({ status: "drained" });
  await Promise.resolve();
  expect(trace.filter((step) => step === "resync")).toHaveLength(1);
});

test("a connect finished while the completion decides gets its own pull",
async () => {
  let reentered = false;
  let second: Promise<void> | null = null;
  const { flow, trace } = harness({
    onResync: (f) => {
      if (reentered) return;
      reentered = true;
      // Past the trailing check: this connect's gap holds changes only a
      // pull of its own can find.
      second = f.begin();
      f.observeDrain({ status: "drained" });
    },
  });

  await flow.begin();
  await second;
  await vi.waitFor(() => {
    expect(trace).toEqual([
      "drain", "start", "idle", "resync", "drain", "start", "idle", "resync",
    ]);
  });
});

test("a start failure during a reconnect rejects begin() though the drain observer took the intent",
async () => {
  const holder: { flow?: ReconnectFlow } = {};
  const { flow, trace } = harness({
    // As the queue does: observers hear the drain before drain() resolves.
    drain: async () => {
      trace.push("drain");
      holder.flow?.observeDrain({ status: "drained" });
      return { status: "drained" };
    },
    replicaSync: (t) => ({
      start: async () => {
        t.push("start");
        await Promise.resolve();
        throw new Error("start failed");
      },
      idle: async () => { t.push("idle"); },
      appliedVersion: () => 7,
    }),
  });
  holder.flow = flow;

  await expect(flow.begin()).rejects.toThrow("start failed");
  expect(trace).toEqual(["drain", "start"]);
});

test("a trailing pull that moves data resyncs a run that found nothing", async () => {
  const feed = gate();
  let version = 7;
  let pulls = 0;
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => {
        t.push("start");
        pulls += 1;
        if (pulls === 2) version += 1;
        return true;
      },
      idle: async () => { t.push("idle"); await feed.promise; },
      appliedVersion: () => version,
    }),
  });

  const first = flow.begin();
  await vi.waitFor(() => { expect(trace).toContain("idle"); });
  const second = flow.begin();
  await vi.waitFor(() => {
    expect(trace.filter((step) => step === "drain")).toHaveLength(2);
  });
  feed.release();
  await Promise.all([first, second]);

  expect(trace.at(-1)).toBe("resync");
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

test("a no-replica session still bumps resync on reconnect", async () => {
  const { flow, trace } = harness({ replicaSync: null });

  await flow.begin();

  expect(trace).toEqual(["drain", "resync"]);
});

test("a reconnect that changed nothing pulls the feed but does not resync",
   async () => {
  // The train symptom: a 2 s blip with an empty queue and nothing on the
  // server costs one changes pull and no view refetch.
  const { flow, trace } = harness({ replicaSync: unmovedReplica });

  await flow.begin();

  expect(trace).toEqual(["drain", "start", "idle"]);
});

test("a stale-views connect resyncs even when nothing moved",
async () => {
  // A first connect flushing a previous page load's leftovers: the views read
  // the server before any of this, and the mount-time catch-up may already
  // have absorbed the flush, so the cursor has nothing left to report.
  const { flow, trace } = harness({ replicaSync: unmovedReplica });

  await flow.begin({ viewsAreStale: true });

  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
});

test("a stale-views connect finished out of band still resyncs",
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

test("a replica that cannot say whether anything moved still resyncs",
   async () => {
  // appliedVersion() is null for a session with no usable database: there is
  // no cursor to compare, so the reconnect must be treated as a change or an
  // online-only session would never refresh its views again.
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); return true; },
      idle: async () => { t.push("idle"); },
      appliedVersion: () => null,
    }),
  });

  await flow.begin();

  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
});

test("a reconnect resyncs once a pull reports the replica has become unusable",
   async () => {
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
    onState: () => undefined,
  });
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); return sync.start(); },
      idle: async () => { t.push("idle"); await sync.idle(); },
      appliedVersion: () => sync.appliedVersion(),
    }),
  });

  // A healthy reconnect over a quiet feed: pulled, nothing to refetch.
  await flow.begin();
  expect(trace).toEqual(["drain", "start", "idle"]);

  latched = new ReplicaUnusableError("no openable database");
  await flow.begin();

  expect(trace).toEqual([
    "drain", "start", "idle", "drain", "start", "idle", "resync",
  ]);
  sync.stop(); // the failed pull scheduled a backoff retry
});

/** The real replicaSync over a memReplica, its changes fetch answered by
 * `fetch`, wrapped so its start and idle land in the flow's trace. */
function realSyncHarness(fetch: (n: number) => Promise<Changes>) {
  let fetches = 0;
  const sync = createReplicaSync({
    replica: memReplica(),
    fetchJson: async () => { fetches += 1; return fetch(fetches); },
    onState: () => undefined,
  });
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => { t.push("start"); return sync.start(); },
      idle: async () => { t.push("idle"); await sync.idle(); },
      appliedVersion: () => sync.appliedVersion(),
    }),
  });
  return { sync, flow, trace, fetches: () => fetches };
}

test("a reconnect whose pull was owed behind a pass that fails still resyncs",
   async () => {
  // A pass started before the drop has its fetch hung on the dying
  // connection; it fails only after the reconnect asked for its own pull.
  const hung = gate();
  const { sync, flow, trace, fetches } = realSyncHarness(async (n) => {
    if (n === 2) {
      await hung.promise;
      throw new TypeError("Failed to fetch");
    }
    return QUIET_FEED;
  });
  await sync.start();
  sync.onSeq(seqOf(1));
  await vi.waitFor(() => { expect(fetches()).toBe(2); });

  const reconnect = flow.begin();
  await vi.waitFor(() => { expect(trace).toContain("start"); });
  hung.release();
  await reconnect;

  // No third fetch: the reconnect's pull was owed, never run.
  expect(fetches()).toBe(2);
  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
  sync.stop(); // the failed pass scheduled a backoff retry
});

test("a reconnect whose own pull fails still resyncs", async () => {
  // The backoff retry applies the gap later and nothing resyncs for it, so
  // the reconnect cannot wait for a pull that may never be its own.
  let failing = false;
  const { sync, flow, trace } = realSyncHarness(async () => {
    if (failing) throw new TypeError("Failed to fetch");
    return QUIET_FEED;
  });
  await sync.start();

  failing = true;
  await flow.begin();

  expect(trace).toEqual(["drain", "start", "idle", "resync"]);
  sync.stop();
});

test("a served trailing pull decides alone after an unserved one", async () => {
  // The trailing pull read from the cursor the failed one left, so the
  // unchanged version is a true answer for the whole run.
  const feed = gate();
  let pulls = 0;
  const { flow, trace } = harness({
    replicaSync: (t) => ({
      start: async () => {
        t.push("start");
        pulls += 1;
        return pulls === 2;
      },
      idle: async () => { t.push("idle"); await feed.promise; },
      appliedVersion: () => 7,
    }),
  });

  const first = flow.begin();
  await vi.waitFor(() => { expect(trace).toContain("idle"); });
  const second = flow.begin();
  await vi.waitFor(() => {
    expect(trace.filter((step) => step === "drain")).toHaveLength(2);
  });
  feed.release();
  await Promise.all([first, second]);

  expect(trace).toEqual(["drain", "start", "idle", "drain", "start", "idle"]);
});

test("a reconnect retries a failed repair before it drains", async () => {
  const trace: string[] = [];
  const flow = createReconnectFlow({
    queue: { drain: async () => { trace.push("drain"); return { status: "drained" }; } },
    replicaSync: movingReplica(trace),
    isMounted: () => true,
    onResync: () => { trace.push("resync"); },
    retryFailedRepair: async () => { trace.push("retryFailedRepair"); },
  });

  await flow.begin();

  expect(trace).toEqual(["retryFailedRepair", "drain", "start", "idle", "resync"]);
});

test("a drain observed while connected never retries a failed repair", async () => {
  const retryFailedRepair = vi.fn(async () => undefined);
  const flow = createReconnectFlow({
    queue: { drain: async () => ({ status: "drained" }) },
    replicaSync: movingReplica([]),
    isMounted: () => true,
    onResync: () => undefined,
    retryFailedRepair,
  });

  flow.observeDrain({ status: "drained" });
  flow.observeDrain({ status: "drained" });
  await Promise.resolve();

  expect(retryFailedRepair).not.toHaveBeenCalled();
});

test("an unmounted reconnect retries no repair", async () => {
  const retryFailedRepair = vi.fn(async () => undefined);
  const flow = createReconnectFlow({
    queue: { drain: async () => ({ status: "drained" }) },
    replicaSync: movingReplica([]),
    isMounted: () => false,
    onResync: () => undefined,
    retryFailedRepair,
  });

  await flow.begin();

  expect(retryFailedRepair).not.toHaveBeenCalled();
});
