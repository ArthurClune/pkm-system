// pattern: Imperative Shell
// Worker-owned FIFO exclusion for replica recovery. Ordinary database work
// runs in arrival order; prepare holds its slot until the matching token is
// committed or aborted, so later calls cannot touch a database being rebuilt.

export interface PreparedRecovery<T> {
  token: string;
  value: T;
}

export interface RecoveryGate {
  run<T>(work: () => Promise<T> | T): Promise<T>;
  prepare<T>(capture: () => Promise<T> | T): Promise<PreparedRecovery<T>>;
  commit<T>(token: string, work: () => Promise<T> | T): Promise<T>;
  abort(token: string): Promise<void>;
}

const INVALID_TOKEN = "invalid or inactive recovery token";

export function createRecoveryGate(newToken: () => string): RecoveryGate {
  let tail = Promise.resolve();
  let active: { token: string; release: () => void } | null = null;

  const queue = <T>(work: () => Promise<T> | T,
                   hold: boolean): Promise<T> => {
    const before = tail.catch(() => undefined);
    let release!: () => void;
    const occupied = new Promise<void>((done) => { release = done; });
    tail = before.then(() => occupied);

    return before.then(async () => {
      try {
        const value = await work();
        if (hold) {
          active = { token: newToken(), release };
        } else {
          release();
        }
        return value;
      } catch (error: unknown) {
        release();
        throw error;
      }
    });
  };

  const take = (token: string): { token: string; release: () => void } => {
    if (active?.token !== token) throw new Error(INVALID_TOKEN);
    const lease = active;
    active = null; // invalidate before async commit; double use must reject
    return lease;
  };

  return {
    run: (work) => queue(work, false),
    async prepare(capture) {
      const value = await queue(capture, true);
      // queue(capture, true) installs active before resolving.
      return { token: active!.token, value };
    },
    async commit(token, work) {
      const lease = take(token);
      try {
        return await work();
      } finally {
        lease.release();
      }
    },
    async abort(token) {
      const lease = take(token);
      lease.release();
    },
  };
}
