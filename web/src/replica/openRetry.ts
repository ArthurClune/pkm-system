// pattern: Functional Core
// Bounded retry for the replica's OPFS open (pkm-c9hp).
//
// sqlite-wasm's OpfsSAHPool VFS acquires an exclusive SyncAccessHandle for
// each pooled file, and a given OPFS file can back only ONE open access
// handle at a time. When a page reloads (a browser F5, or the Playwright
// suite navigating with a full document load), the freshly spawned replica
// worker calls installOpfsSAHPoolVfs before the terminating worker has
// released its handles — throwing a transient
//   "Access Handles cannot be created if there is another open Access
//    Handle or Writable stream associated with the same file."
// The stale handles release moments later, so retrying the open with a short
// backoff recovers cleanly. Left unhandled, the open error propagates out of
// replica.enqueue, the sync provider mistakes it for a server rejection
// (onDesync), and the legacy repair wipes the active outline to the server's
// (empty) state, detaching the editor.
//
// sleep and the open factory are injected so the schedule is unit-testable
// without a real Worker, OPFS, or timers.

/** Recognise the OPFS SyncAccessHandle contention that a page reload/
 * navigation races into — the only failure this retry should absorb. */
export function isSahPoolContention(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /access handle/i.test(message)
    || /createSyncAccessHandle/i.test(message);
}

export interface OpenRetryDeps {
  /** Injected wait between attempts (real worker: setTimeout). */
  sleep: (ms: number) => Promise<void>;
  /** Backoff schedule; its length is the number of retries after the first
   * attempt. Kept short (~1.5s): a browser reload that releases the prior
   * pool quickly recovers the replica, while a persistent holder (a second
   * live tab, or the e2e's per-navigation worker churn) fails fast so the
   * op queue can fall back to direct online delivery instead of stalling. */
  delaysMs?: readonly number[];
  /** Which errors are transient; defaults to SAH-pool contention only. */
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_DELAYS = [50, 100, 200, 400, 800] as const;

export async function openWithRetry<T>(
  open: () => Promise<T>,
  deps: OpenRetryDeps,
): Promise<T> {
  const delays = deps.delaysMs ?? DEFAULT_DELAYS;
  const retryable = deps.isRetryable ?? isSahPoolContention;
  let lastError: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await open();
    } catch (error: unknown) {
      lastError = error;
      if (attempt === delays.length || !retryable(error)) throw error;
      await deps.sleep(delays[attempt]);
    }
  }
  throw lastError;
}
