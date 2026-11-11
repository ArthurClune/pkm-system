// pattern: Imperative Shell
// One rule for an async operation that callers may ask for while it runs:
// every call settles only after a run that could have served it. A call
// during a run joins it while `joinable()` holds; after that it is owed one
// run that starts when this one ends, in the same reaction that settles
// this run's callers, so no call can land in a gap between the run's last
// step and the moment it stops counting as in flight.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export interface Coalesced<A, R> {
  (args: A): Promise<R>;
  /** Settles once no run is in flight and none is owed; never rejects.
   * Every call within one busy period returns the same promise; a call
   * while quiet returns a new, already resolved one. */
  idle(): Promise<void>;
  /** From a run's start until its busy period ends. */
  running(): boolean;
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** Every call settles only after a run that could have served it: one that
 * started after the call, or one that had not yet passed `joinable()` when
 * the call arrived. A run that rejects rejects every call waiting on it or
 * owed behind it. Omitting `joinable` means a call during a run never joins
 * it. */
export function coalesce<A, R>(
  run: (args: A) => Promise<R>,
  opts: { merge: (pending: A, next: A) => A; joinable?: () => boolean },
): Coalesced<A, R> {
  let current: Deferred<R> | null = null;
  let owed: { args: A; settle: Deferred<R> } | null = null;
  let busy: Deferred<void> | null = null;

  const endBusyPeriod = (): void => {
    busy?.resolve();
    busy = null;
  };

  const start = (args: A, settle: Deferred<R>): void => {
    // Set before `run` is invoked, so a call from its synchronous part
    // joins or is owed like any other call during the run.
    current = settle;
    let ran: Promise<R>;
    try {
      ran = run(args);
    } catch (error: unknown) {
      ran = Promise.reject(error);
    }
    void ran.then(
      (value) => {
        current = null;
        const next = owed;
        owed = null;
        if (next) start(next.args, next.settle);
        settle.resolve(value);
        if (!current) endBusyPeriod();
      },
      (reason: unknown) => {
        current = null;
        const next = owed;
        owed = null;
        settle.reject(reason);
        next?.settle.reject(reason);
        endBusyPeriod();
      },
    );
  };

  const call = (args: A): Promise<R> => {
    if (!current) {
      const settle = deferred<R>();
      start(args, settle);
      return settle.promise;
    }
    if (owed) {
      owed.args = opts.merge(owed.args, args);
      return owed.settle.promise;
    }
    if (opts.joinable?.() === true) return current.promise;
    owed = { args, settle: deferred<R>() };
    return owed.settle.promise;
  };

  return Object.assign(call, {
    idle: (): Promise<void> => {
      if (!current) return Promise.resolve();
      busy ??= deferred<void>();
      return busy.promise;
    },
    running: (): boolean => current !== null,
  });
}
