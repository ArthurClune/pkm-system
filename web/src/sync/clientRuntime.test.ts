// @vitest-environment node
// The startup gate and poison repair, driven without React: a recording fake
// queue and replica sync around an in-memory replica, so the call order and
// the sync events can be read back exactly.
import { describe, expect, test } from "vitest";
import { ReplicaUnusableError } from "../replica/errors";
import { createClientRuntime, type ClientRuntimeDeps } from "./clientRuntime";
import { memReplica } from "./memReplica";
import type { PoisonEvent, PoisonMarkFailure } from "./opQueue";
import type { SyncEvent } from "./syncState";
import { pendingRowIdOf, batchIdOf } from "../test-helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const poisonEvent = (id: number, batch: string): PoisonEvent => ({
  id: pendingRowIdOf(id), batch_id: batchIdOf(batch), ops: [],
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
  /** Runs inside each deleteBatch, after the call is recorded. */
  deleteBatch?: () => Promise<void>;
  isMounted?: () => boolean;
}

function setup(opts: SetupOptions = {}) {
  const calls: string[] = [];
  const events: SyncEvent[] = [];
  /** The errors noteUnavailable heard, by message. */
  const unavailable: string[] = [];
  const poisonFns = new Set<(event: PoisonEvent) => void>();
  const markFailedFns = new Set<(failure: PoisonMarkFailure) => void>();
  const unmatchedFns = new Set<() => void>();
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
    onPoisonMarkUnmatched: (fn) => {
      unmatchedFns.add(fn);
      return () => { unmatchedFns.delete(fn); };
    },
  };
  const replica = memReplica({
    poisonedBatches: async () => {
      calls.push("poisonedBatches");
      return opts.poisoned ? opts.poisoned() : [];
    },
    deleteBatch: async (id, batchId) => {
      calls.push(`deleteBatch(${id},${batchId})`);
      await opts.deleteBatch?.();
      return { pending: 0 };
    },
  });
  const replicaSync: ClientRuntimeDeps["replicaSync"] = {
    start: async () => { calls.push("start"); },
    rebaseAuthoritative: async (reason) => {
      calls.push(`rebaseAuthoritative(${reason})`);
      await opts.rebase?.();
    },
    noteUnavailable: (error) => { unavailable.push(error.message); },
  };
  const runtime = createClientRuntime({
    queue, replica, replicaSync,
    onSyncEvent: (event) => { events.push(event); },
    isMounted: opts.isMounted,
  });
  const emitPoison = (event: PoisonEvent) => poisonFns.forEach((fn) => fn(event));
  const emitMarkFailed = (failure: PoisonMarkFailure) =>
    markFailedFns.forEach((fn) => fn(failure));
  const emitUnmatched = () => unmatchedFns.forEach((fn) => fn());
  return { calls, events, unavailable, runtime, emitPoison, emitMarkFailed,
           emitUnmatched, poisonFns, markFailedFns, unmatchedFns };
}

describe("clientRuntime startup", () => {
  test("startup with no poison resumes and starts", async () => {
    const h = setup();
    await h.runtime.startup();
    await h.runtime.startupRun();
    expect(h.calls).toEqual([
      "setOnline(false)", "pause(startup)", "retryPoisonMarks",
      "poisonedBatches", "resume(poison)", "resume(startup)", "start",
    ]);
    expect(h.events).toEqual([{ type: "poison-discovery-cleared" }]);
    expect(h.runtime.discoveringPoison()).toBe(false);
  });

  test("startup with discovered poison repairs before start", async () => {
    const event = poisonEvent(3, "b-3");
    const h = setup({ poisoned: async () => [event] });
    await h.runtime.startup();
    expect(h.calls).toEqual([
      "setOnline(false)", "pause(startup)", "retryPoisonMarks",
      "poisonedBatches", "pause(poison)",
      "rebaseAuthoritative(poison)", "resume(startup)", "deleteBatch(3,b-3)",
      "refreshPending", "resume(poison)", "start",
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
    expect(h.calls).not.toContain("resume(startup)");
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
    expect(h.unavailable).toEqual(["no opfs"]);
    expect(h.calls).toContain("resume(startup)");
    expect(h.calls).not.toContain("start");
    expect(h.events).toEqual([]);
    expect(h.runtime.discoveringPoison()).toBe(false);
  });

  test("a discovery failure that is not unusable keeps the gate", async () => {
    const h = setup({ poisoned: async () => { throw new Error("rpc timeout"); } });
    await h.runtime.startup();
    expect(h.calls).not.toContain("resume(startup)");
    expect(h.events).toEqual([
      { type: "poison-discovery-failed", error: "rpc timeout" },
    ]);
    expect(h.runtime.discoveringPoison()).toBe(true);
  });

  test("a failed mark retry holds the gate without discovery", async () => {
    const h = setup({ marks: async () => { throw new Error("mark rpc"); } });
    await h.runtime.startup();
    expect(h.calls).toEqual(["setOnline(false)", "pause(startup)", "retryPoisonMarks"]);
  });
});

/** Holds the first deleteBatch until `release()`; later ones pass. */
const holdFirstDelete = () => {
  const held = deferred<void>();
  let first = true;
  return {
    deleteBatch: (): Promise<void> => {
      if (!first) return Promise.resolve();
      first = false;
      return held.promise;
    },
    release: () => { held.resolve(); },
  };
};

describe("clientRuntime repair and retry", () => {
  test("a poison event after the repair began deleting gets a repair of its own", async () => {
    const hold = holdFirstDelete();
    const h = setup({ deleteBatch: hold.deleteBatch });
    await h.runtime.startup();
    h.calls.length = 0;
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    expect(h.calls.at(-1)).toBe("deleteBatch(1,b-1)");
    h.emitPoison(poisonEvent(2, "b-2"));
    hold.release();
    await flush();
    expect(h.calls.filter((c) => c === "rebaseAuthoritative(poison)"))
      .toHaveLength(2);
    expect(h.calls.filter((c) => c.startsWith("deleteBatch")))
      .toEqual(["deleteBatch(1,b-1)", "deleteBatch(2,b-2)"]);
  });

  test("a repair after a failed one keeps the failed targets", async () => {
    let fail = true;
    const h = setup({
      rebase: async () => { if (fail) throw new Error("snapshot 500"); },
    });
    await h.runtime.startup();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    expect(h.events.at(-1)).toMatchObject({ type: "repair-failed" });
    fail = false;
    h.calls.length = 0;
    h.emitPoison(poisonEvent(2, "b-2"));
    await flush();
    expect(h.calls.filter((c) => c.startsWith("deleteBatch")))
      .toEqual(["deleteBatch(1,b-1)", "deleteBatch(2,b-2)"]);
  });

  test("continueStartup starts the replica when its own repair succeeded, though another is owed",
  async () => {
    const hold = holdFirstDelete();
    const h = setup({
      poisoned: async () => [poisonEvent(3, "b-3")],
      deleteBatch: hold.deleteBatch,
    });
    const run = h.runtime.startup();
    await flush();
    expect(h.calls.at(-1)).toBe("deleteBatch(3,b-3)");
    h.emitPoison(poisonEvent(4, "b-4"));
    hold.release();
    await run;
    expect(h.calls).toContain("start");
  });

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
      "pause(poison)", "rebaseAuthoritative(poison)", "deleteBatch(4,b-4)",
      "refreshPending", "resume(poison)", "start",
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
      "retryPoisonMarks", "poisonedBatches", "pause(poison)",
      "rebaseAuthoritative(poison)", "resume(startup)", "deleteBatch(6,b-6)", "refreshPending",
      "resume(poison)", "start",
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
    expect(h.calls).toEqual([
      "poisonedBatches", "resume(poison)", "resume(startup)", "start",
    ]);
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
      "discardPoisonIntents",
      "resume(poison)", "poisonedBatches", "resume(poison)", "resume(startup)",
      "start",
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
      "discardPoisonIntents",
      "resume(poison)",
    ]);
    expect(h.events).toEqual([{ type: "poison-intents-discarded" }]);
  });

  test("discarding a rejected change while a repair runs keeps the poison claim " +
       "until the repair ends", async () => {
    const rebase = deferred<void>();
    const h = setup({ rebase: () => rebase.promise });
    await h.runtime.startup();
    h.calls.length = 0;
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    await h.runtime.discardPoisonIntents();
    await flush();
    const afterDiscard = (): string[] =>
      h.calls.slice(h.calls.indexOf("discardPoisonIntents") + 1);
    expect(afterDiscard()).toEqual([]);
    rebase.resolve();
    await flush();
    expect(afterDiscard().at(-1)).toBe("resume(poison)");
  });

  test("an unmatched marking round releases poison when no repair runs",
  async () => {
    let mounted = true;
    const h = setup({ isMounted: () => mounted });
    await h.runtime.startup();
    h.calls.length = 0;
    h.emitUnmatched();
    expect(h.calls).toEqual(["resume(poison)"]);
    mounted = false;
    h.emitUnmatched();
    h.runtime.dispose();
    h.emitUnmatched();
    expect(h.calls).toEqual(["resume(poison)"]);
    expect(h.unmatchedFns.size).toBe(0);
  });

  test("an unmatched marking round during a repair keeps the claim", async () => {
    const rebase = deferred<void>();
    const h = setup({ rebase: () => rebase.promise });
    await h.runtime.startup();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    h.calls.length = 0;
    h.emitUnmatched();
    expect(h.calls).toEqual([]);
    rebase.resolve();
    await flush();
    expect(h.calls).toEqual([
      "deleteBatch(1,b-1)", "refreshPending", "resume(poison)",
    ]);
  });

  test("an unmatched marking round during discovery leaves the release to " +
       "continueStartup", async () => {
    const marks = deferred<readonly PoisonEvent[]>();
    const h = setup({ marks: () => marks.promise });
    const run = h.runtime.startup();
    h.emitUnmatched();
    expect(h.calls).toEqual(["setOnline(false)", "pause(startup)", "retryPoisonMarks"]);
    marks.resolve([]);
    await run;
    expect(h.calls).toEqual([
      "setOnline(false)", "pause(startup)", "retryPoisonMarks",
      "poisonedBatches", "resume(poison)", "resume(startup)", "start",
    ]);
  });

  test("dispose mid-repair never resumes or starts", async () => {
    const rebase = deferred<void>();
    const event = poisonEvent(7, "b-7");
    const h = setup({ poisoned: async () => [event], rebase: () => rebase.promise });
    const run = h.runtime.startup();
    await flush();
    h.runtime.dispose();
    h.runtime.dispose();
    rebase.resolve();
    await run;
    expect(h.calls.slice(-1)).toEqual([
      "deleteBatch(7,b-7)",
    ]);
    expect(h.events).toEqual([{ type: "repair-started", event }]);
    // A Retry after dispose still never restarts the replica sync.
    await h.runtime.runRetry({ kind: "repair-targets" });
    expect(h.calls).not.toContain("start");
  });

  test("a repair owed when the runtime is disposed does no work", async () => {
    const hold = holdFirstDelete();
    const h = setup({ deleteBatch: hold.deleteBatch });
    await h.runtime.startup();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    expect(h.calls.at(-1)).toBe("deleteBatch(1,b-1)");
    h.emitPoison(poisonEvent(2, "b-2"));
    h.runtime.dispose();
    h.calls.length = 0;
    hold.release();
    await flush();
    expect(h.calls).toEqual([]);
  });

  test("a repair owed across an unmount gap is left to the next connect",
       async () => {
    let mounted = true;
    const hold = holdFirstDelete();
    const h = setup({ deleteBatch: hold.deleteBatch, isMounted: () => mounted });
    await h.runtime.startup();
    h.emitPoison(poisonEvent(1, "b-1"));
    await flush();
    h.emitPoison(poisonEvent(2, "b-2"));
    // A StrictMode replay: unmounted for a moment, then live again.
    mounted = false;
    hold.release();
    await flush();
    expect(h.calls).not.toContain("deleteBatch(2,b-2)");
    mounted = true;
    h.calls.length = 0;
    await h.runtime.retryFailedRepair();
    expect(h.calls).toEqual([
      "pause(poison)", "rebaseAuthoritative(poison)", "deleteBatch(2,b-2)",
      "refreshPending", "resume(poison)", "start",
    ]);
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
      "setOnline(false)", "pause(startup)", "retryPoisonMarks",
    ]);
    mounted = true;
    await h.runtime.continueStartup([]);
    mounted = false;
    h.emitPoison(poisonEvent(1, "b-1"));
    h.emitMarkFailed({ event: poisonEvent(1, "b-1"), error: "x" });
    await h.runtime.discardPoisonIntents();
    expect(h.unavailable).toEqual(["gone"]);
    expect(h.calls.filter((c) => c === "resume(startup)")).toHaveLength(1);
    expect(h.calls).not.toContain("rebaseAuthoritative(poison)");
    expect(h.events).toEqual([]);
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
      "deleteBatch(1,b-1)", "deleteBatch(2,b-2)", "resume(poison)", "start",
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
      "pause(poison)", "rebaseAuthoritative(poison)", "deleteBatch(3,b-3)",
      "refreshPending", "resume(poison)", "start",
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
