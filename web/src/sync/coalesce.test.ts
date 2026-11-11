import { describe, expect, test, vi } from "vitest";
import { coalesce } from "./coalesce";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A `run` whose every invocation records its args and waits on a deferred
 * the test settles. */
function controlledRun<A, R>() {
  const runs: { args: A; done: ReturnType<typeof deferred<R>> }[] = [];
  const run = (args: A): Promise<R> => {
    const done = deferred<R>();
    runs.push({ args, done });
    return done.promise;
  };
  return { run, runs };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const concat = (pending: number[], next: number[]): number[] =>
  [...pending, ...next];

/** Records whether, and how, a promise has settled. */
function track<T>(promise: Promise<T>) {
  const seen: { state: "pending" | "fulfilled" | "rejected"; value?: unknown } =
    { state: "pending" };
  promise.then(
    (value) => { seen.state = "fulfilled"; seen.value = value; },
    (error: unknown) => { seen.state = "rejected"; seen.value = error; },
  );
  return seen;
}

describe("coalesce", () => {
  test("a call while quiet starts a run with its args", async () => {
    const { run, runs } = controlledRun<number[], string>();
    const call = coalesce(run, { merge: concat });

    const p = call([1]);

    expect(runs.map((r) => r.args)).toEqual([[1]]);
    runs[0].done.resolve("a");
    await expect(p).resolves.toBe("a");
  });

  test("a call during a run gets a second run", async () => {
    const { run, runs } = controlledRun<number[], string>();
    const call = coalesce(run, { merge: concat });

    const first = call([1]);
    const second = call([2]);
    const secondSeen = track(second);

    expect(second).not.toBe(first);
    expect(runs).toHaveLength(1);
    runs[0].done.resolve("a");
    await expect(first).resolves.toBe("a");
    expect(runs.map((r) => r.args)).toEqual([[1], [2]]);
    expect(secondSeen.state).toBe("pending");
    runs[1].done.resolve("b");
    await expect(second).resolves.toBe("b");
  });

  test("calls during one run share one owed run with merged args", async () => {
    const { run, runs } = controlledRun<number[], string>();
    const merge = vi.fn(concat);
    const call = coalesce(run, { merge });

    void call([1]);
    const second = call([2]);
    const third = call([3]);
    const fourth = call([4]);

    expect(third).toBe(second);
    expect(fourth).toBe(second);
    expect(merge.mock.calls).toEqual([[[2], [3]], [[2, 3], [4]]]);
    runs[0].done.resolve("a");
    await flush();
    expect(runs.map((r) => r.args)).toEqual([[1], [2, 3, 4]]);
    runs[1].done.resolve("b");
    await expect(second).resolves.toBe("b");
  });

  test("a call before joinable() turns false joins the run", async () => {
    const { run, runs } = controlledRun<number[], string>();
    const call = coalesce(run, { merge: concat, joinable: () => true });

    const first = call([1]);
    const joined = call([2]);

    expect(joined).toBe(first);
    runs[0].done.resolve("a");
    await expect(joined).resolves.toBe("a");
    await flush();
    expect(runs).toHaveLength(1);
    expect(call.running()).toBe(false);
  });

  test("a call after joinable() turns false gets its own run", async () => {
    const { run, runs } = controlledRun<number[], string>();
    let open = true;
    const call = coalesce(run, { merge: concat, joinable: () => open });

    const first = call([1]);
    open = false;
    const late = call([2]);

    expect(late).not.toBe(first);
    runs[0].done.resolve("a");
    await expect(first).resolves.toBe("a");
    expect(runs.map((r) => r.args)).toEqual([[1], [2]]);
    runs[1].done.resolve("b");
    await expect(late).resolves.toBe("b");
  });

  test("once a call is owed, joinable() is not asked again in that run",
    async () => {
      const { run, runs } = controlledRun<number[], string>();
      let open = false;
      const joinable = vi.fn(() => open);
      const call = coalesce(run, { merge: concat, joinable });

      void call([1]);
      const owed = call([2]);
      open = true;
      const later = call([3]);

      expect(later).toBe(owed);
      expect(joinable).toHaveBeenCalledTimes(1);

      runs[0].done.resolve("a");
      await flush();
      // The owed run is a new run: a call during it is asked again.
      const joinsOwedRun = call([4]);
      expect(joinable).toHaveBeenCalledTimes(2);
      expect(joinsOwedRun).toBe(owed);
      expect(runs.map((r) => r.args)).toEqual([[1], [2, 3]]);
    });

  test("a throwing run rejects its joiners and the next call runs afresh",
    async () => {
      const { run, runs } = controlledRun<number[], string>();
      let open = true;
      const call = coalesce(run, { merge: concat, joinable: () => open });
      const boom = new Error("boom");

      const first = call([1]);
      const joined = call([2]);
      open = false;
      const owed = call([3]);
      const callers = [track(first), track(joined), track(owed)];

      runs[0].done.reject(boom);
      await flush();

      for (const seen of callers) {
        expect(seen).toEqual({ state: "rejected", value: boom });
      }
      // The owed call's args were dropped with it: no run took them, and
      // the next call starts with its own args only.
      expect(runs).toHaveLength(1);
      expect(call.running()).toBe(false);
      const next = call([4]);
      expect(runs.map((r) => r.args)).toEqual([[1], [4]]);
      runs[1].done.resolve("b");
      await expect(next).resolves.toBe("b");
    });

  test("a run that throws synchronously rejects like a rejected run",
    async () => {
      const boom = new Error("boom");
      let throws = true;
      const run = vi.fn((args: number[]): Promise<number[]> => {
        if (throws) throw boom;
        return Promise.resolve(args);
      });
      const call = coalesce(run, { merge: concat });

      const first = call([1]);
      const owed = call([2]);
      const seen = [track(first), track(owed)];
      await flush();

      for (const s of seen) expect(s).toEqual({ state: "rejected", value: boom });
      expect(run).toHaveBeenCalledTimes(1);
      throws = false;
      await expect(call([3])).resolves.toEqual([3]);
    });

  test("a call from inside run's synchronous part joins or is owed",
    async () => {
      const inner: Promise<string>[] = [];
      const makeRun = (call: () => (args: number[]) => Promise<string>) => {
        const { run, runs } = controlledRun<number[], string>();
        const reentrant = (args: number[]): Promise<string> => {
          const p = run(args);
          if (runs.length === 1) inner.push(call()([9]));
          return p;
        };
        return { reentrant, runs };
      };

      const joining = makeRun(() => joinCall);
      const joinCall = coalesce(joining.reentrant, {
        merge: concat, joinable: () => true,
      });
      const outerJoin = joinCall([1]);
      expect(inner[0]).toBe(outerJoin);
      joining.runs[0].done.resolve("a");
      await flush();
      expect(joining.runs).toHaveLength(1);

      const owing = makeRun(() => owedCall);
      const owedCall = coalesce(owing.reentrant, { merge: concat });
      const outerOwed = owedCall([1]);
      expect(inner[1]).not.toBe(outerOwed);
      owing.runs[0].done.resolve("a");
      await flush();
      expect(owing.runs.map((r) => r.args)).toEqual([[1], [9]]);
      owing.runs[1].done.resolve("b");
      await expect(inner[1]).resolves.toBe("b");
    });

  test("a caller's continuation finds the owed run already in flight",
    async () => {
      const { run, runs } = controlledRun<number[], string>();
      const call = coalesce(run, { merge: concat });
      const seen: { runs?: number; running?: boolean } = {};
      let fromContinuation: Promise<string> | undefined;

      const first = call([1]);
      const owed = call([2]);
      void first.then(() => {
        seen.runs = runs.length;
        seen.running = call.running();
        fromContinuation = call([3]);
      });

      runs[0].done.resolve("a");
      await flush();

      expect(seen).toEqual({ runs: 2, running: true });
      // Owed behind the second run, not a third run started beside it.
      expect(runs).toHaveLength(2);
      expect(fromContinuation).not.toBe(owed);
      runs[1].done.resolve("b");
      await flush();
      expect(runs.map((r) => r.args)).toEqual([[1], [2], [3]]);
      runs[2].done.resolve("c");
      await expect(fromContinuation).resolves.toBe("c");
    });

  test("a joiner's continuation joins the owed run already in flight",
    async () => {
      const { run, runs } = controlledRun<number[], string>();
      let open = true;
      const call = coalesce(run, { merge: concat, joinable: () => open });
      let fromJoiner: Promise<string> | undefined;

      void call([1]);
      const joined = call([2]);
      open = false;
      const owed = call([3]);
      void joined.then(() => { fromJoiner = call([4]); });
      open = true;

      runs[0].done.resolve("a");
      await flush();

      expect(fromJoiner).toBe(owed);
      expect(runs.map((r) => r.args)).toEqual([[1], [3]]);
    });

  test("a call landing after the run's last step but before the helper sees "
    + "it settle gets a run", async () => {
    const runs: { args: number[]; done: ReturnType<typeof deferred<string>> }[]
      = [];
    let late: Promise<string> | undefined;
    const call = coalesce((args: number[]): Promise<string> => {
      const done = deferred<string>();
      runs.push({ args, done });
      // Registered before the helper's own reaction on the same promise, so
      // it runs after the run's last step and before the helper clears it.
      if (runs.length === 1) void done.promise.then(() => { late = call([2]); });
      return done.promise;
    }, { merge: concat });

    const first = call([1]);
    runs[0].done.resolve("a");
    await expect(first).resolves.toBe("a");
    await flush();

    expect(runs.map((r) => r.args)).toEqual([[1], [2]]);
    runs[1].done.resolve("b");
    await expect(late).resolves.toBe("b");
  });

  test("idle() settles after owed runs and never rejects", async () => {
    const { run, runs } = controlledRun<number[], string>();
    const call = coalesce(run, { merge: concat });
    const order: string[] = [];

    const first = call([1]);
    void call([2]);
    const idle = call.idle();
    void idle.then(() => order.push("idle"));
    void first.then(() => order.push("first"));

    runs[0].done.resolve("a");
    await flush();
    expect(order).toEqual(["first"]);
    runs[1].done.resolve("b");
    await flush();
    expect(order).toEqual(["first", "idle"]);

    // In one reaction: the run's callers settle before idle() does.
    order.length = 0;
    void call.idle();
    const lone = call([5]);
    void call.idle().then(() => order.push("idle"));
    void lone.then(() => order.push("lone"));
    runs[2].done.resolve("c");
    await flush();
    expect(order).toEqual(["lone", "idle"]);

    const failing = call([3]);
    const owed = call([4]);
    failing.catch(() => undefined);
    owed.catch(() => undefined);
    const idleAfterFailure = track(call.idle());
    runs[3].done.reject(new Error("boom"));
    await flush();
    expect(idleAfterFailure.state).toBe("fulfilled");
  });

  test("idle() returns one promise per busy period and a new resolved one "
    + "while quiet", async () => {
    const { run, runs } = controlledRun<number[], string>();
    const call = coalesce(run, { merge: concat });

    const quietA = call.idle();
    const quietB = call.idle();
    expect(quietA).not.toBe(quietB);
    await expect(quietA).resolves.toBeUndefined();

    void call([1]);
    const busy = call.idle();
    expect(call.idle()).toBe(busy);
    void call([2]);
    runs[0].done.resolve("a");
    await flush();
    // Still the same busy period: the owed run is in flight.
    expect(call.idle()).toBe(busy);
    runs[1].done.resolve("b");
    await flush();

    const after = call.idle();
    expect(after).not.toBe(busy);
    await expect(after).resolves.toBeUndefined();
  });

  test("running() is true from a run's start until nothing is owed",
    async () => {
      const { run, runs } = controlledRun<number[], string>();
      const call = coalesce(run, { merge: concat });

      expect(call.running()).toBe(false);
      void call([1]);
      expect(call.running()).toBe(true);
      void call([2]);
      runs[0].done.resolve("a");
      await flush();
      expect(call.running()).toBe(true);
      runs[1].done.resolve("b");
      await flush();
      expect(call.running()).toBe(false);

      const failing = call([3]);
      failing.catch(() => undefined);
      expect(call.running()).toBe(true);
      runs[2].done.reject(new Error("boom"));
      await flush();
      expect(call.running()).toBe(false);
    });
});
