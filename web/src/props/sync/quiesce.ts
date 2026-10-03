// pattern: Imperative Shell
// Quiescence: bring every client to rest before the oracle looks. Faults are
// cleared and every client goes online; then each client drains and pulls,
// round after round, until none has a pending row, a poisoned row or a lane
// entry and every cursor has reached the server's latest seq. An explicit
// drain() posts at once even while a retry backoff timer is armed
// (queueState: only offline, recovery or dispose stop a drain), and pull()
// forces a pull, so no round waits out a backoff.
//
// This diverges from the app in one way. online() calls the reconnect flow's
// begin() even for a client that is already online, so quiesce stands in for
// a reconnect. A repair that failed while connected (after a lostPull, say)
// therefore gets one retry here, where the app would wait for a reconnect or
// a Retry click.
//
// A poisoned row counts as unsettled: pendingCount skips it, and a rejection
// moves no seq, so without it a lone client's poison repair could still be
// rebasing when quiesce returned. The repair deletes the row only after its
// rebase has committed, and what it does after the delete (completing the
// repair and resuming the queue) runs before the delete's caller yields.
//
// Not settling within the limit is a liveness failure, and so is a step that
// never finishes: every await here is bounded by the deadline, and a hung one
// is abandoned with a QuiesceError carrying each client's state.
import type { SyncSeq } from "../../api/brands";
import type { HarnessClient } from "./harnessClient";
import type { ServerControl } from "./serverControl";

export class QuiesceError extends Error {
  override name = "QuiesceError";
}

interface ClientRest {
  name: string;
  pending: number;
  poisoned: number;
  lane: number;
  cursor: SyncSeq;
}

const ROUND_PAUSE_MS = 20;
/** How long a liveness report waits for each client's state. */
const REPORT_WAIT_MS = 1_000;

export const TIMED_OUT = Symbol("timed out");

/** `p`, or TIMED_OUT once `ms` has passed. */
export async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms));
  });
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
  }
}

const atRest = (s: ClientRest, latest: SyncSeq): boolean =>
  s.pending === 0 && s.poisoned === 0 && s.lane === 0 && s.cursor === latest;

const restOf = async (c: HarnessClient): Promise<ClientRest> => ({
  name: c.name,
  pending: await c.replica.pendingCount(),
  poisoned: (await c.replica.poisonedBatches()).length,
  lane: c.unsentInMemory(),
  cursor: c.cursor(),
});

const show = (s: ClientRest, latest: SyncSeq | string): string =>
  `${s.name}: pending ${s.pending}, poisoned ${s.poisoned}, lane ${s.lane},` +
  ` cursor ${s.cursor}, latest ${latest}`;

/** Each client's state for a liveness report, each read itself bounded:
 * the worker may be what hung. */
async function report(clients: HarnessClient[], server: ServerControl): Promise<string> {
  const latest = await within(server.latestSeq(), REPORT_WAIT_MS);
  const shown = latest === TIMED_OUT ? "unknown" : latest;
  const lines = await Promise.all(clients.map(async (c) => {
    const s = await within(restOf(c), REPORT_WAIT_MS);
    return s === TIMED_OUT
      ? `${c.name}: state unreadable (replica did not answer), cursor ${c.cursor()},` +
        ` lane ${c.unsentInMemory()}, latest ${shown}`
      : show(s, shown);
  }));
  return lines.join("; ");
}

/** One round: drain and pull every client, then read where each stands. */
async function round(clients: HarnessClient[], server: ServerControl): Promise<{
  latest: SyncSeq; states: ClientRest[];
}> {
  for (const c of clients) {
    await c.queue.drain();
    await c.pull();
  }
  // The pulls above have finished; this catches any a drain's ack started.
  await Promise.all(clients.map((c) => c.replicaSync.idle()));
  const latest = await server.latestSeq();
  return { latest, states: await Promise.all(clients.map(restOf)) };
}

export async function quiesce(clients: HarnessClient[], server: ServerControl,
                              limitMs = 30_000): Promise<void> {
  const deadline = Date.now() + limitMs;
  const fail = async (why: string): Promise<never> => {
    throw new QuiesceError(
      `did not settle in ${limitMs}ms${why}: ${await report(clients, server)}`);
  };
  for (const c of clients) c.transport.clearFaults();
  // Called together so each client's synchronous part of going online runs
  // before quiesce first yields.
  const online = await within(Promise.all(clients.map((c) => c.online())),
                              deadline - Date.now());
  if (online === TIMED_OUT) return fail(" (going online hung)");
  for (;;) {
    const result = await within(round(clients, server), deadline - Date.now());
    if (result === TIMED_OUT) return fail(" (a drain, pull or read hung)");
    const { latest, states } = result;
    if (states.every((s) => atRest(s, latest))) return;
    if (Date.now() >= deadline) {
      throw new QuiesceError(`did not settle in ${limitMs}ms: ` +
                             states.map((s) => show(s, latest)).join("; "));
    }
    await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
  }
}
