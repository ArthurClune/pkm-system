// pattern: Imperative Shell
// Quiescence: bring every client to rest before the oracle looks. Faults are
// cleared and every client goes online; then each client drains and pulls,
// round after round, until none has a pending row or a lane entry and every
// cursor has reached the server's latest seq. An explicit drain() posts at
// once even while a retry backoff timer is armed (queueState: only offline,
// recovery or dispose stop a drain), and pull() forces a pull, so no round
// waits out a backoff. Not settling within the limit is a liveness failure.
import type { SyncSeq } from "../../api/brands";
import type { HarnessClient } from "./harnessClient";
import type { ServerControl } from "./serverControl";

export class QuiesceError extends Error {
  override name = "QuiesceError";
}

interface ClientRest {
  name: string;
  pending: number;
  lane: number;
  cursor: SyncSeq;
}

const ROUND_PAUSE_MS = 20;

const atRest = (s: ClientRest, latest: SyncSeq): boolean =>
  s.pending === 0 && s.lane === 0 && s.cursor === latest;

const report = (states: readonly ClientRest[], latest: SyncSeq): string =>
  states.map((s) => `${s.name}: pending ${s.pending}, lane ${s.lane},` +
                    ` cursor ${s.cursor}, latest ${latest}`).join("; ");

export async function quiesce(clients: HarnessClient[], server: ServerControl,
                              limitMs = 30_000): Promise<void> {
  for (const c of clients) c.transport.clearFaults();
  // Called together so each client's synchronous part of going online runs
  // before quiesce first yields.
  await Promise.all(clients.map((c) => c.online()));
  const deadline = Date.now() + limitMs;
  for (;;) {
    for (const c of clients) {
      await c.queue.drain();
      await c.pull();
    }
    // The pulls above have finished; this catches any a drain's ack started.
    await Promise.all(clients.map((c) => c.replicaSync.idle()));
    const latest = await server.latestSeq();
    const states: ClientRest[] = await Promise.all(clients.map(async (c) => ({
      name: c.name,
      pending: await c.replica.pendingCount(),
      lane: c.unsentInMemory(),
      cursor: c.cursor(),
    })));
    if (states.every((s) => atRest(s, latest))) return;
    if (Date.now() >= deadline) {
      throw new QuiesceError(
        `did not settle in ${limitMs}ms: ${report(states, latest)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
  }
}
