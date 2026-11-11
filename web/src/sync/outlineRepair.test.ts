import { describe, expect, test } from "vitest";
import { createOutlineRepair, type OutlineRepairDeps } from "./outlineRepair";
import type { SyncEvent } from "./syncState";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A repairSessions stand-in whose attempts each wait on a deferred the
 * test settles: resolving one calls onStable first, as the real repair does
 * before its promise settles. */
function setup(overrides: Partial<OutlineRepairDeps> = {}) {
  const attempts: Deferred[] = [];
  const events: SyncEvent[] = [];
  const state = { resumes: 0, mounted: true };
  const repair = createOutlineRepair({
    repairSessions: async (onStable) => {
      const attempt = deferred();
      attempts.push(attempt);
      await attempt.promise;
      onStable();
    },
    onEvent: (event) => { events.push(event); },
    resume: () => { state.resumes += 1; },
    isMounted: () => state.mounted,
    ...overrides,
  });
  return { repair, attempts, events, state };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The desync of a lane rejection, whose barrier the repair owes back. */
const LANE = { lane: true } as const;

describe("run", () => {
  test("a successful repair resumes delivery", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].resolve();
    await run;
    expect(h.state.resumes).toBe(1);
    expect(h.events).toEqual([
      { type: "outline-repair-started", error: "bad op" },
      { type: "outline-repair-succeeded", error: "bad op" },
    ]);
    expect(h.repair.rejected()).toEqual(new Error("bad op"));
  });

  test("a failed repair reports the failure and does not resume", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;
    expect(h.state.resumes).toBe(0);
    expect(h.events).toEqual([
      { type: "outline-repair-started", error: "bad op" },
      { type: "outline-repair-failed", error: "bad op", repairError: "fetch failed" },
    ]);
  });

  test("a run while one is in flight joins it and records the newer error", async () => {
    const h = setup();
    const first = h.repair.run(new Error("first"), LANE);
    const second = h.repair.run(new Error("second"), LANE);
    expect(second).toBe(first);
    h.attempts[0].resolve();
    await second;
    expect(h.attempts).toHaveLength(1);
    expect(h.state.resumes).toBe(1);
    expect(h.repair.rejected()).toEqual(new Error("second"));
  });

  test("a repair that succeeds after unmount neither reports nor resumes", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.state.mounted = false;
    h.attempts[0].resolve();
    await run;
    expect(h.state.resumes).toBe(0);
    expect(h.events).toEqual([{ type: "outline-repair-started", error: "bad op" }]);
  });

  test("a repair for a local refusal reports but resumes nothing", async () => {
    const h = setup();
    const run = h.repair.run(new Error("over limit"), { lane: false });
    h.attempts[0].resolve();
    await run;
    expect(h.state.resumes).toBe(0);
    expect(h.events.map((e) => e.type)).toEqual([
      "outline-repair-started", "outline-repair-succeeded",
    ]);
  });

  test("a lane rejection joining a local refusal's run is resumed by it",
       async () => {
    const h = setup();
    const run = h.repair.run(new Error("over limit"), { lane: false });
    void h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].resolve();
    await run;
    expect(h.attempts).toHaveLength(1);
    expect(h.state.resumes).toBe(1);
  });

  test("a rejection arriving after a run's onStable gets a run of its own",
       async () => {
    const reading = deferred();
    const tail = deferred();
    const state = { resumes: 0, attempts: 0 };
    const repair = createOutlineRepair({
      repairSessions: async (onStable) => {
        state.attempts += 1;
        if (state.attempts === 1) {
          await reading.promise;
          onStable();
          await tail.promise;
        } else {
          onStable();
        }
      },
      onEvent: () => undefined,
      resume: () => { state.resumes += 1; },
      isMounted: () => true,
    });
    const first = repair.run(new Error("over limit"), { lane: false });
    reading.resolve();
    await flush();
    const second = repair.run(new Error("bad op"), LANE);
    tail.resolve();
    await first;
    await second;
    expect(state.attempts).toBe(2);
    expect(state.resumes).toBe(1);
  });

  test("a lane rejection whose run failed is resumed by the retry", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;
    const retry = h.repair.run(h.repair.rejected());
    h.attempts[1].resolve();
    await retry;
    expect(h.state.resumes).toBe(1);
  });

  test("clear forgets the rejected error", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].resolve();
    await run;
    h.repair.clear();
    expect(h.repair.rejected()).toBeUndefined();
  });
});

describe("retryFailed", () => {
  test("reruns a failed repair with the recorded error", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;

    const retry = h.repair.retryFailed();
    await flush();
    expect(h.attempts).toHaveLength(2);
    h.attempts[1].resolve();
    await retry;
    expect(h.state.resumes).toBe(1);
    expect(h.events.map((e) => e.type)).toEqual([
      "outline-repair-started", "outline-repair-failed",
      "outline-repair-started", "outline-repair-succeeded",
    ]);
    expect(h.events[2]).toEqual({ type: "outline-repair-started", error: "bad op" });
  });

  test("does nothing when no repair ever ran", async () => {
    const h = setup();
    await h.repair.retryFailed();
    expect(h.attempts).toHaveLength(0);
    expect(h.events).toEqual([]);
  });

  test("does not rerun a repair that succeeded", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].resolve();
    await run;
    await h.repair.retryFailed();
    expect(h.attempts).toHaveLength(1);
    expect(h.state.resumes).toBe(1);
  });

  test("a failure that a later run repaired is not rerun", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;
    // The banner's Retry gets there first.
    const retry = h.repair.run(h.repair.rejected());
    h.attempts[1].resolve();
    await retry;
    await h.repair.retryFailed();
    expect(h.attempts).toHaveLength(2);
    expect(h.state.resumes).toBe(1);
  });

  test("waits for an in-flight repair and reruns it once if it fails", async () => {
    const h = setup();
    void h.repair.run(new Error("bad op"), LANE);
    const retry = h.repair.retryFailed();
    await flush();
    expect(h.attempts).toHaveLength(1);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await flush();
    expect(h.attempts).toHaveLength(2);
    h.attempts[1].resolve();
    await retry;
    expect(h.state.resumes).toBe(1);
  });

  test("a reconnect during a stable run waits for the owed run and retries it once if it fails",
       async () => {
    const reading = deferred();
    const tail = deferred();
    const state = { resumes: 0, attempts: 0 };
    const repair = createOutlineRepair({
      repairSessions: async (onStable) => {
        state.attempts += 1;
        if (state.attempts === 1) {
          await reading.promise;
          onStable();
          await tail.promise;
          return;
        }
        if (state.attempts === 2) throw new TypeError("fetch failed");
        onStable();
      },
      onEvent: () => undefined,
      resume: () => { state.resumes += 1; },
      isMounted: () => true,
    });
    const first = repair.run(new Error("over limit"), { lane: false });
    reading.resolve();
    await flush();
    // Past the first run's onStable: owed a run of its own.
    const owed = repair.run(new Error("bad op"), LANE);
    const retry = repair.retryFailed();
    tail.resolve();
    await first;
    await owed;
    await retry;
    expect(state.attempts).toBe(3);
    expect(state.resumes).toBe(1);
  });

  test("waits for an in-flight repair and does not rerun it if it succeeds", async () => {
    const h = setup();
    void h.repair.run(new Error("bad op"), LANE);
    const retry = h.repair.retryFailed();
    h.attempts[0].resolve();
    await retry;
    expect(h.attempts).toHaveLength(1);
    expect(h.state.resumes).toBe(1);
  });

  test("two connects waiting on one failed attempt rerun it once", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;
    const first = h.repair.retryFailed();
    const second = h.repair.retryFailed();
    await flush();
    expect(h.attempts).toHaveLength(2);
    h.attempts[1].resolve();
    await Promise.all([first, second]);
    expect(h.attempts).toHaveLength(2);
    expect(h.state.resumes).toBe(1);
  });

  test("a rerun that fails again waits for the next connect", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;
    const retry = h.repair.retryFailed();
    await flush();
    h.attempts[1].reject(new TypeError("fetch failed"));
    await retry;
    await flush();
    expect(h.attempts).toHaveLength(2);

    const next = h.repair.retryFailed();
    await flush();
    expect(h.attempts).toHaveLength(3);
    h.attempts[2].resolve();
    await next;
    expect(h.state.resumes).toBe(1);
  });

  /** A first run held after its onStable, so a later run() is owed. */
  const heldPastStable = (mounted: { value: boolean }) => {
    const reading = deferred();
    const tail = deferred();
    const state = { resumes: 0, attempts: 0 };
    const repair = createOutlineRepair({
      repairSessions: async (onStable) => {
        state.attempts += 1;
        if (state.attempts === 1) {
          await reading.promise;
          onStable();
          await tail.promise;
          return;
        }
        onStable();
      },
      onEvent: () => undefined,
      resume: () => { state.resumes += 1; },
      isMounted: () => mounted.value,
    });
    return { repair, reading, tail, state };
  };

  test("a run owed when the owner unmounts never starts", async () => {
    const mounted = { value: true };
    const h = heldPastStable(mounted);
    const first = h.repair.run(new Error("over limit"), { lane: false });
    h.reading.resolve();
    await flush();
    const owed = h.repair.run(new Error("bad op"), LANE);
    mounted.value = false;
    h.tail.resolve();
    await first;
    await owed;
    expect(h.state.attempts).toBe(1);
  });

  test("a run owed across an unmount gap is rerun by the next connect",
       async () => {
    const mounted = { value: true };
    const h = heldPastStable(mounted);
    const first = h.repair.run(new Error("over limit"), { lane: false });
    h.reading.resolve();
    await flush();
    const owed = h.repair.run(new Error("bad op"), LANE);
    // A StrictMode replay: unmounted for a moment, then live again.
    mounted.value = false;
    h.tail.resolve();
    await first;
    await owed;
    mounted.value = true;
    await h.repair.retryFailed();
    expect(h.state.attempts).toBe(2);
    expect(h.state.resumes).toBe(1);
  });

  test("does not rerun after unmount", async () => {
    const h = setup();
    const run = h.repair.run(new Error("bad op"), LANE);
    h.attempts[0].reject(new TypeError("fetch failed"));
    await run;
    h.state.mounted = false;
    await h.repair.retryFailed();
    expect(h.attempts).toHaveLength(1);
    expect(h.state.resumes).toBe(0);
  });
});
