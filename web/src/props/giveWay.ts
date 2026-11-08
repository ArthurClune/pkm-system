// pattern: Imperative Shell
// vitest's worker answers the runner over RPC, and a call left unanswered
// for 60 s fails the run with `Timeout calling "onTaskUpdate"` although
// every test passed. A property that never reaches the macrotask queue
// starves that reply: awaiting a resolved promise is not enough, only a
// macrotask (setImmediate) lets the worker read it. setup.ts runs this
// before every example of every property in the suite.

/** Far below vitest's 60 s RPC timeout; each pause costs microseconds. */
export const GIVE_WAY_MS = 1_000;

/** A hook that returns a setImmediate promise once GIVE_WAY_MS has passed
 * since the last one, and nothing in between. */
export function makeGiveWay(
  intervalMs: number = GIVE_WAY_MS,
  now: () => number = Date.now,
): () => Promise<void> | undefined {
  let last = now();
  return () => {
    if (now() - last < intervalMs) return undefined;
    return new Promise<void>((resolve) => setImmediate(() => {
      last = now();
      resolve();
    }));
  };
}
