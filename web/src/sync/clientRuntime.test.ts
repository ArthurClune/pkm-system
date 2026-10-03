// @vitest-environment node
// The startup gate and poison repair, driven without React: a recording fake
// queue and replica sync around an in-memory replica, so the call order and
// the sync events can be read back exactly.
import { describe, expect, test } from "vitest";
import type { BatchId } from "../api/brands";
import type { PendingRowId } from "../replica/client";
import { ReplicaUnusableError } from "../replica/errors";
import { createClientRuntime, type ClientRuntimeDeps } from "./clientRuntime";
import { memReplica } from "./memReplica";
import type { PoisonEvent, PoisonMarkFailure } from "./opQueue";
import type { ReplicaState } from "./replicaSync";
import type { SyncEvent } from "./syncState";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const poisonEvent = (id: number, batch: string): PoisonEvent => ({
  id: id as PendingRowId, batch_id: batch as BatchId, ops: [],
  status: 400, message: "rejected",
});

/** Settle every pending promise chain the runtime started. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

interface SetupOptions {
  marks?: () => Promise<readonly PoisonEvent[]>;
  poisoned?: () => Promise<PoisonEvent[]>;
  rebase?: () => Promise<void>;
  isMounted?: () => boolean;
}

function setup(opts: SetupOptions = {}) {
  const calls: string[] = [];
  const events: SyncEvent[] = [];
  const states: ReplicaState[] = [];
  const poisonFns = new Set<(event: PoisonEvent) => void>();
  const markFailedFns = new Set<(failure: PoisonMarkFailure) => void>();
  const queue: ClientRuntimeDeps["queue"] = {
    setOnline: (online) => { calls.push(`setOnline(${online})`); },
    pause: (reason) => { calls.push(`pause(${reason})`); },
    resume: (reason) => { calls.push(`resume(${reason})`); },
    retryPoisonMarks: () => {
      calls.push("retryPoisonMarks");
      return opts.marks?.() ?? Promise.resolve([]);
    },
    refreshPending: async () => { calls.push("refreshPending"); return 0; },
    discardPoisonIntents: () => { calls.push("discardPoisonIntents"); },
    onPoison: (fn) => { poisonFns.add(fn); return () => { poisonFns.delete(fn); }; },
    onPoisonMarkFailed: (fn) => {
      markFailedFns.add(fn);
      return () => { markFailedFns.delete(fn); };
    },
  };
  const replica = memReplica({
    poisonedBatches: async () => {
      calls.push("poisonedBatches");
      return opts.poisoned ? opts.poisoned() : [];
    },
    deleteBatch: async (id, batchId) => {
      calls.push(`deleteBatch(${id},${batchId})`);
      return { pending: 0 };
    },
  });
  const replicaSync: ClientRuntimeDeps["replicaSync"] = {
    start: async () => { calls.push("start"); },
    rebaseAuthoritative: async (reason) => {
      calls.push(`rebaseAuthoritative(${reason})`);
      await opts.rebase?.();
    },
    completeAuthoritativeRepair: (reason) => {
      calls.push(`completeAuthoritativeRepair(${reason})`);
    },
  };
  const runtime = createClientRuntime({
    queue, replica, replicaSync,
    onSyncEvent: (event) => { events.push(event); },
    onReplicaState: (state) => { states.push(state); },
    isMounted: opts.isMounted,
  });
  const emitPoison = (event: PoisonEvent) => poisonFns.forEach((fn) => fn(event));
  const emitMarkFailed = (failure: PoisonMarkFailure) =>
    markFailedFns.forEach((fn) => fn(failure));
  return { calls, events, states, runtime, emitPoison, emitMarkFailed,
           poisonFns, markFailedFns };
}

describe("clientRuntime startup", () => {
  test("startup with no poison resumes and starts", async () => {
    const h = setup();
    await h.runtime.startup();
    await h.runtime.startupRun();
    expect(h.calls).toEqual([
      "setOnline(false)", "pause(recovery)", "retryPoisonMarks",
      "poisonedBatches", "resume(recovery)", "start",
    ]);
    expect(h.events).toEqual([{ type: "poison-discovery-cleared" }]);
    expect(h.runtime.discoveringPoison()).toBe(false);
  });

  test("startup with discovered poison repairs before start", async () => {
    const event = poisonEvent(3, "b-3");
    const h = setup({ poisoned: async () => [event] });
    await h.runtime.startup();
    expect(h.calls).toEqual([
      "setOnline(false)", "pause(recovery)", "retryPoisonMarks",
      "poisonedBatches", "rebaseAuthoritative(poison)", "deleteBatch(3,b-3)",
      "refreshPending", "completeAuthoritativeRepair(poison)",
      "resume(recovery)", "start",
    ]);
    expect(h.events).toEqual([
      { type: "repair-started", event },
      { type: "repair-succeeded", event },
    ]);
  });

  test("concurrent poison events coalesce into one repair", async () => {
    const rebase = deferred<void>();
    const h = setup({ rebase: () => rebase.promise });
    await h.runtime.startup();
    h.calls.length = 0;
    const first = poisonEvent(1, "b-1");
    const second = poisonEvent(2, "b-2");
    h.emitPoison(second);
    h.emitPoison(first);
    rebase.resolve();
    await flush();
    expect(h.calls.filter((c) => c.startsWith("rebaseAuthoritative")))
      .toHaveLength(1);
    expect(h.calls.filter((c) => c.startsWith("deleteBatch")))
      .toEqual(["deleteBatch(1,b-1)", "deleteBatch(2,b-2)"]);
  });

  test("poison while startup is still discovering is left to discovery", async () => {
    const marks = deferred<readonly PoisonEvent[]>();
    const h = setup({ marks: () => marks.promise });
    void h.runtime.startup();
    expect(h.runtime.discoveringPoison()).toBe(true);
    h.emitPoison(poisonEvent(1, "b-1"));
    expect(h.calls).not.toContain("rebaseAuthoritative(poison)");
    marks.resolve([]);
    await h.runtime.startupRun();
  });

  test("dispose mid-startup stops resume and callbacks", async () => {
    const marks = deferred<readonly PoisonEvent[]>();
    const h = setup({ marks: () => marks.promise });
    void h.runtime.startup();
    h.runtime.dispose();
    marks.resolve([]);
    await h.runtime.startupRun();
    await flush();
    expect(h.calls).not.toContain("resume(recovery)");
    expect(h.calls).not.toContain("start");
    expect(h.events).toEqual([]);
    expect(h.poisonFns.size).toBe(0);
    expect(h.markFailedFns.size).toBe(0);
  });

  test("unusable replica at discovery reports no-replica", async () => {
    const h = setup({
      poisoned: async () => { throw new ReplicaUnusableError("no opfs"); },
    });
    await h.runtime.startup();
    expect(h.states).toEqual([{ mode: "no-replica" }]);
    expect(h.calls).toContain("resume(recovery)");
    expect(h.calls).not.toContain("start");
    expect(h.events).toEqual([{ type: "replica-unusable", error: "no opfs" }]);
    expect(h.runtime.discoveringPoison()).toBe(false);
  });

  test("a discovery failure that is not unusable keeps the gate", async () => {
    const h = setup({ poisoned: async () => { throw new Error("rpc timeout"); } });
    await h.runtime.startup();
    expect(h.calls).not.toContain("resume(recovery)");
    expect(h.events).toEqual([
      { type: "poison-discovery-failed", error: "rpc timeout" },
    ]);
    expect(h.runtime.discoveringPoison()).toBe(true);
  });

  test("a failed mark retry holds the gate without discovery", async () => {
    const h = setup({ marks: async () => { throw new Error("mark rpc"); } });
    await h.runtime.startup();
    expect(h.calls).toEqual(["setOnline(false)", "pause(recovery)", "retryPoisonMarks"]);
  });
});

describe("clientRuntime repair and retry", () => {
  test("a failed repair reports and does not start", async () => {
    const event = poisonEvent(4, "b-4");
    const h = setup({
      poisoned: async () => [event],
      rebase: async () => { throw new Error("snapshot 500"); },
    });
    await h.runtime.startup();
    expect(h.calls).not.toContain("start");
    expect(h.events).toEqual([
      { type: "repair-started", event },
      { type: "repair-failed", event, error: "snapshot 500" },
    ]);
  });

  test("repair-targets retry repairs the retained targets then starts", async () => {
    const event = poisonEvent(4, "b-4");
    let fail = true;
    const h = setup({
      poisoned: async () => [event],
      rebase: async () => { if (fail) throw new Error("snapshot 500"); },
    });
    await h.runtime.startup();
    fail = false;
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "repair-targets" });
    expect(h.calls).toEqual([
      "rebaseAuthoritative(poison)", "deleteBatch(4,b-4)", "refreshPending",
      "completeAuthoritativeRepair(poison)", "resume(recovery)", "start",
    ]);
  });

  test("a mark failure retains its event as the repair target", async () => {
    const h = setup();
    await h.runtime.startup();
    const event = poisonEvent(5, "b-5");
    h.emitMarkFailed({ event, error: new Error("mark rpc") });
    expect(h.events.at(-1)).toEqual({
      type: "poison-mark-failed", event, error: "mark rpc",
    });
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "repair-targets" });
    expect(h.calls).toContain("deleteBatch(5,b-5)");
    h.runtime.clearRepairTargets();
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "repair-targets" });
    expect(h.calls).toEqual(["start"]);
  });

  test("retry-poison-marks continuing startup feeds marks into discovery", async () => {
    const event = poisonEvent(6, "b-6");
    let marks: () => Promise<readonly PoisonEvent[]> =
      async () => { throw new Error("mark rpc"); };
    const h = setup({ marks: () => marks() });
    await h.runtime.startup();
    marks = async () => [event];
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "retry-poison-marks", continueStartup: true });
    expect(h.calls).toEqual([
      "retryPoisonMarks", "poisonedBatches", "rebaseAuthoritative(poison)",
      "deleteBatch(6,b-6)", "refreshPending",
      "completeAuthoritativeRepair(poison)", "resume(recovery)", "start",
    ]);
  });

  test("retry-poison-marks mid-session awaits the repair then restarts", async () => {
    const h = setup();
    await h.runtime.startup();
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "retry-poison-marks", continueStartup: false });
    // No successful repair yet this session, so no restart either.
    expect(h.calls).toEqual(["retryPoisonMarks"]);
  });

  test("retry-poison-marks that fails again stops there", async () => {
    const h = setup({ marks: async () => { throw new Error("mark rpc"); } });
    await h.runtime.startup();
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "retry-poison-marks", continueStartup: false });
    expect(h.calls).toEqual(["retryPoisonMarks"]);
  });

  test("continue-startup re-runs discovery with no marks", async () => {
    let fail = true;
    const h = setup({
      poisoned: async () => { if (fail) throw new Error("rpc"); return []; },
    });
    await h.runtime.startup();
    fail = false;
    h.calls.length = 0;
    await h.runtime.runRetry({ kind: "continue-startup" });
    expect(h.calls).toEqual(["poisonedBatches", "resume(recovery)", "start"]);
  });

  test("none does nothing", async () => {
    const h = setup();
    await h.runtime.runRetry({ kind: "none" });
    expect(h.calls).toEqual([]);
  });

  test("discarding intents during startup rejoins discovery", async () => {
    const h = setup({ marks: async () => { throw new Error("mark rpc"); } });
    await h.runtime.startup();
    h.calls.length = 0;
    await h.runtime.discardPoisonIntents();
    expect(h.calls).toEqual([
      "discardPoisonIntents", "completeAuthoritativeRepair(poison)",
      "poisonedBatches", "resume(recovery)", "start",
    ]);
    expect(h.events).toEqual([
      { type: "poison-intents-discarded" }, { type: "poison-discovery-cleared" },
    ]);
  });

  test("discarding intents mid-session resumes delivery", async () => {
    const h = setup();
    await h.runtime.startup();
    h.calls.length = 0;
    h.events.length = 0;
    await h.runtime.discardPoisonIntents();
    expect(h.calls).toEqual([
      "discardPoisonIntents", "completeAuthoritativeRepair(poison)",
      "resume(recovery)",
    ]);
    expect(h.events).toEqual([{ type: "poison-intents-discarded" }]);
  });

  test("dispose mid-repair releases the claim but never resumes or starts", async () => {
    const rebase = deferred<void>();
    const event = poisonEvent(7, "b-7");
    const h = setup({ poisoned: async () => [event], rebase: () => rebase.promise });
    const run = h.runtime.startup();
    await flush();
    h.runtime.dispose();
    h.runtime.dispose();
    rebase.resolve();
    await run;
    expect(h.calls.slice(-2)).toEqual([
      "deleteBatch(7,b-7)", "completeAuthoritativeRepair(poison)",
    ]);
    expect(h.events).toEqual([{ type: "repair-started", event }]);
    // A Retry after dispose still never restarts the replica sync.
    await h.runtime.runRetry({ kind: "repair-targets" });
    expect(h.calls).not.toContain("start");
  });

  test("an owner's unmount stops work before dispose runs", async () => {
    let mounted = true;
    const h = setup({
      poisoned: async () => { throw new ReplicaUnusableError("gone"); },
      isMounted: () => mounted,
    });
    const marks = h.runtime.startup();
    mounted = false;
    await marks;
    expect(h.calls).toEqual([
      "setOnline(false)", "pause(recovery)", "retryPoisonMarks",
    ]);
    mounted = true;
    await h.runtime.continueStartup([]);
    mounted = false;
    h.emitPoison(poisonEvent(1, "b-1"));
    h.emitMarkFailed({ event: poisonEvent(1, "b-1"), error: "x" });
    await h.runtime.discardPoisonIntents();
    expect(h.states).toEqual([{ mode: "no-replica" }]);
    expect(h.calls.filter((c) => c === "resume(recovery)")).toHaveLength(1);
    expect(h.calls).not.toContain("rebaseAuthoritative(poison)");
    expect(h.events).toEqual([{ type: "replica-unusable", error: "gone" }]);
  });
});

describe("clientRuntime reconnect", () => {
  /** A rebase that fails while `offline` is set, as the snapshot fetch does. */
  const offlineRebase = () => {
    const net = { offline: false, attempts: 0 };
    const rebase = async () => {
      net.attempts += 1;
      if (net.offline) throw new TypeError("fetch failed");
    };
    return { net, rebase };
  };

  test("a poison repair that failed offline is retried on reconnect", async () => {
    const { net, rebase } = offlineRebase();
    const rebaseGate = deferred<void>();
    let gated = true;
    const h = setup({
      rebase: async () => {
        if (gated) { gated = false; await rebaseGate.promise; }
        await rebase();
      },
    });
    await h.runtime.startup();
    h.calls.length = 0;
    h.events.length = 0;
    const first = poisonEvent(1, "b-1");
    const second = poisonEvent(2, "b-2");
    h.emitPoison(first);
    h.emitPoison(second);
    net.offline = true;
    rebaseGate.resolve();
    await flush();
    expect(h.calls).not.toContain("deleteBatch(1,b-1)");

    net.offline = false;
    await h.runtime.retryFailedRepair();

    expect(h.calls.filter((c) => c === "rebaseAuthoritative(poison)"))
      .toHaveLength(2);
    expect(h.calls).toEqual(expect.arrayContaining([
      "deleteBatch(1,b-1)", "deleteBatch(2,b-2)", "resume(recovery)", "start",
    ]));
    expect(h.calls.at(-1)).toBe("start");
    expect(h.events).toEqual([
      { type: "repair-started", event: first },
      { type: "repair-failed", event: first, error: "fetch failed" },
      { type: "repair-started", event: first },
      { type: "repair-succeeded", event: first },
    ]);
  });

  test("a reconnect with no failed repair does nothing", async () => {
    const h = setup();
    await h.runtime.startup();
    h.calls.length = 0;
    await h.runtime.retryFailedRepair();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    h.calls.length = 0;
    h.events.length = 0;
    // The repair above succeeded: nothing is left for a reconnect to retry.
    await h.runtime.retryFailedRepair();
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual([]);
  });

  test("a repair that fails again waits for the next reconnect", async () => {
    const { net, rebase } = offlineRebase();
    const h = setup({ rebase });
    await h.runtime.startup();
    net.offline = true;
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    await h.runtime.retryFailedRepair();
    await flush();
    // One attempt per reconnect: the failed retry schedules nothing.
    expect(net.attempts).toBe(2);
    expect(h.calls).not.toContain("deleteBatch(1,b-1)");

    net.offline = false;
    await h.runtime.retryFailedRepair();
    expect(net.attempts).toBe(3);
    expect(h.calls).toContain("deleteBatch(1,b-1)");
    expect(h.calls.at(-1)).toBe("start");
  });

  test("a startup repair that failed offline is retried on reconnect", async () => {
    const event = poisonEvent(3, "b-3");
    const { net, rebase } = offlineRebase();
    net.offline = true;
    const h = setup({ poisoned: async () => [event], rebase });
    await h.runtime.startup();
    expect(h.calls).not.toContain("start");

    net.offline = false;
    h.calls.length = 0;
    await h.runtime.retryFailedRepair();
    expect(h.calls).toEqual([
      "rebaseAuthoritative(poison)", "deleteBatch(3,b-3)", "refreshPending",
      "completeAuthoritativeRepair(poison)", "resume(recovery)", "start",
    ]);
  });

  test("a reconnect during a repair that then fails retries it once", async () => {
    // A network switch: the snapshot fetch hangs on the dead connection,
    // the socket reconnects on a new one, and only then does the fetch fail.
    const inFlight = deferred<void>();
    let attempt = 0;
    const h = setup({
      rebase: async () => {
        attempt += 1;
        if (attempt === 1) await inFlight.promise;
      },
    });
    await h.runtime.startup();
    h.calls.length = 0;
    h.events.length = 0;
    const event = poisonEvent(1, "b-1");
    h.emitPoison(event);
    await flush();
    const reconnect = h.runtime.retryFailedRepair();
    inFlight.reject(new TypeError("fetch failed"));
    await reconnect;

    expect(attempt).toBe(2);
    expect(h.calls.filter((c) => c === "deleteBatch(1,b-1)")).toHaveLength(1);
    expect(h.calls.at(-1)).toBe("start");
    expect(h.events).toEqual([
      { type: "repair-started", event },
      { type: "repair-failed", event, error: "fetch failed" },
      { type: "repair-started", event },
      { type: "repair-succeeded", event },
    ]);
  });

  test("a reconnect during a repair that then succeeds retries nothing", async () => {
    const inFlight = deferred<void>();
    const h = setup({ rebase: () => inFlight.promise });
    await h.runtime.startup();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    const first = h.runtime.retryFailedRepair();
    const second = h.runtime.retryFailedRepair();
    inFlight.resolve();
    await Promise.all([first, second]);
    expect(h.calls.filter((c) => c === "rebaseAuthoritative(poison)"))
      .toHaveLength(1);
  });

  test("two connects during a repair that then fails retry it once", async () => {
    const inFlight = deferred<void>();
    let attempt = 0;
    const h = setup({
      rebase: async () => {
        attempt += 1;
        if (attempt === 1) await inFlight.promise;
      },
    });
    await h.runtime.startup();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    const first = h.runtime.retryFailedRepair();
    const second = h.runtime.retryFailedRepair();
    inFlight.reject(new TypeError("fetch failed"));
    await Promise.all([first, second]);
    expect(attempt).toBe(2);
  });

  test("a reconnect after a failed poison mark leaves the mark to Retry", async () => {
    const { net, rebase } = offlineRebase();
    const h = setup({ rebase });
    await h.runtime.startup();
    net.offline = true;
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    // A later rejection whose durable mark failed: repairing now would
    // repair over an unmarked row, so only the mark retry may run.
    const unmarked = poisonEvent(2, "b-2");
    h.emitMarkFailed({ event: unmarked, error: new Error("mark rpc") });
    net.offline = false;
    h.calls.length = 0;
    await h.runtime.retryFailedRepair();
    expect(h.calls).toEqual([]);
  });

  test("a disposed runtime retries nothing on reconnect", async () => {
    const { net, rebase } = offlineRebase();
    const h = setup({ rebase });
    await h.runtime.startup();
    net.offline = true;
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    h.runtime.dispose();
    net.offline = false;
    h.calls.length = 0;
    await h.runtime.retryFailedRepair();
    expect(h.calls).toEqual([]);
  });
});
