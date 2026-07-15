// pattern: Imperative Shell
// Drives the replica from the server (spec section 3): snapshot bootstrap,
// nudge-driven windowed pulls, and the guarded re-bootstrap paths (feed
// reset / generation flip / schema-version mismatch). The guardrail from
// the epic: a re-bootstrap NEVER tears down a database whose pending queue
// is non-empty — queued batches are flushed to the server first (batch_id
// dedup makes replayed flushes safe), and a failed flush keeps the old
// database: degraded beats data loss.

import type { Changes, Snapshot } from "../replica/apply";
import type { PendingBatch, RecoveryCommit, Replica } from "../replica/client";
import type { OpQueue } from "./opQueue";

export type ReplicaState =
  | { mode: "starting" }
  | { mode: "no-replica" }
  | { mode: "ready" }
  | { mode: "recovery-failed"; error: string };

export interface ReplicaSync {
  /** Idempotent: first call initializes (+ bootstrap/recovery as needed);
   * later calls catch up the feed. Call on every reconnect. */
  start(): Promise<void>;
  /** WS nudge: pull if the journal moved past our cursor. */
  onSeq(seq: number): void;
  /** Resolves when no pull is in flight (tests, reconnect ordering). */
  idle(): Promise<void>;
  /** Full-snapshot poison repair under the shared recovery lease. Delivery
   * remains paused on return so the provider can delete the poison row, bump
   * view resync, and only then resume the queue. */
  rebaseAuthoritative(reason: "poison"): Promise<void>;
  /** Release poison recovery ownership after row deletion/resync scheduling.
   * This does not resume delivery; the provider owns that final ordering. */
  completeAuthoritativeRepair(reason: "poison"): void;
}

export interface ReplicaSyncDeps {
  replica: Replica;
  /** apiFetch-shaped; typed loosely so tests can hand in plain mocks. */
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>;
  clientId: string;
  onState: (s: ReplicaState) => void;
  /** Delivery is paused while the worker recovery lease owns the database. */
  queue?: Pick<OpQueue, "pause" | "resume"> &
    Partial<Pick<OpQueue, "onPoisonPending">>;
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function createReplicaSync(deps: ReplicaSyncDeps): ReplicaSync {
  const { replica, fetchJson, clientId, onState } = deps;
  const queue = deps.queue ?? {
    pause: () => undefined,
    resume: () => undefined,
  };
  let cursor = 0;
  let started = false;
  let disabled = false; // no-replica: permanent for this session
  let pulling: Promise<void> | null = null;
  let again = false;
  let authoritativeRepair: "poison" | null = null;
  const poisonPreempted = Symbol("poison-preempted-normal-recovery");

  // The queue fires this synchronously on the 4xx path, before the durable
  // poison mark and its public event. A normal recovery lease acquired just
  // before that mark therefore cannot flush its stale pre-mark batch list.
  queue.onPoisonPending?.(() => { authoritativeRepair = "poison"; });

  const bootstrap = async (): Promise<void> => {
    const snap = (await fetchJson("/api/sync/snapshot")) as Snapshot;
    await replica.applySnapshot(snap);
    cursor = snap.seq;
  };

  const assertNormalRecoveryStillOwnsFlush = (): void => {
    if (authoritativeRepair === "poison") throw poisonPreempted;
  };

  const flushBatches = async (
    batches: PendingBatch[],
    beforePost: () => void,
  ): Promise<void> => {
    for (const b of batches) {
      // poisoned batches were already rejected by the server; retrying
      // them forever would wedge recovery (spec section 6)
      if (b.poisoned) continue;
      beforePost();
      await fetchJson("/api/ops", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, batch_id: b.batch_id,
                               ops: b.ops }),
      });
    }
  };

  const runRecovery = async (kind: RecoveryCommit["kind"], options: {
    flush: boolean;
    resume: boolean;
    reportReplicaFailure: boolean;
  }): Promise<void> => {
    queue.pause("recovery");
    let token: string | null = null;
    try {
      const lease = await replica.prepareRecovery();
      token = lease.token;
      if (options.flush) {
        assertNormalRecoveryStillOwnsFlush();
        await flushBatches(
          [...lease.batches], assertNormalRecoveryStillOwnsFlush,
        );
      }
      const snapshot = (await fetchJson("/api/sync/snapshot")) as Snapshot;
      await replica.commitRecovery(token, { kind, snapshot });
      token = null; // commit released the worker gate
      cursor = snapshot.seq;
    } catch (error: unknown) {
      const poisonOwnsRecovery = authoritativeRepair === "poison" ||
        error === poisonPreempted;
      if (options.reportReplicaFailure && !poisonOwnsRecovery) {
        onState({ mode: "recovery-failed", error: errText(error) });
      }
      if (token !== null) {
        // Commit failures release in the worker; abort is still attempted so
        // transport failures cannot leave a known lease held. Double-token
        // rejection is deliberately ignored in favor of the original error.
        try { await replica.abortRecovery(token); } catch { /* already released */ }
      }
      throw error;
    } finally {
      if (options.resume && authoritativeRepair !== "poison") {
        queue.resume("recovery");
      }
    }
  };

  const recover = async (kind: RecoveryCommit["kind"]): Promise<boolean> => {
    try {
      await runRecovery(kind, {
        flush: true, resume: true, reportReplicaFailure: true,
      });
      return true;
    } catch {
      return false;
    }
  };

  const pullLoop = async (): Promise<void> => {
    do {
      again = false;
      let done = false;
      while (!done) {
        const expectedPendingIds = (await replica.pendingBatches())
          .map((batch) => batch.id);
        const feed = (await fetchJson(
          `/api/sync/changes?since=${cursor}`)) as Changes;
        const res = await replica.applyChanges(feed, expectedPendingIds);
        if (res.status === "pending-changed") continue;
        if (res.status === "needs-bootstrap") {
          // A rejected batch owns recovery until the provider has deleted its
          // durable row and scheduled resync. Normal Task 2 recovery would
          // flush later valid rows and resume a boolean-paused queue, breaking
          // poison's stronger ordering and failed-Retry barrier.
          if (authoritativeRepair === "poison") return;
          if (!(await recover("rebase"))) return;
          done = feed.latest_seq <= cursor;
        } else {
          cursor = res.cursor;
          done = feed.next_since >= feed.latest_seq;
        }
      }
    } while (again);
  };

  const pull = (): Promise<void> => {
    if (!started) return Promise.resolve();
    if (pulling) {
      again = true;
      return pulling;
    }
    pulling = pullLoop()
      .catch(() => undefined) // network gone: next nudge/reconnect retries
      .finally(() => { pulling = null; });
    return pulling;
  };

  const doStart = async (): Promise<void> => {
    const init = await replica.init();
    if (!init.ok) {
      disabled = true;
      onState({ mode: "no-replica" });
      return;
    }
    cursor = init.cursor;
    if (init.schemaMismatch) {
      // deploy changed the DDL: one coordinator flushes and rebuilds under
      // the same worker lease used for feed generation/reset recovery.
      if (!(await recover("reset"))) return;
    } else if (init.empty) {
      await bootstrap();
    }
    started = true;
    onState({ mode: "ready" });
    await pull();
  };
  let starting: Promise<void> | null = null;

  return {
    async start() {
      if (disabled) return;
      if (started) {
        await pull();
        return;
      }
      // single-flight: the mount-time start (cold start offline needs no
      // socket) and the first connect's start must share one initialization
      starting ??= doStart().finally(() => { starting = null; });
      await starting;
    },
    onSeq(seq) {
      if (pulling) {
        // a window is in flight; its server-side latest_seq may predate
        // this nudge, so ask for one trailing pull instead of dropping it
        again = true;
        return;
      }
      if (!started || seq <= cursor) return;
      void pull();
    },
    idle() {
      return pulling ?? Promise.resolve();
    },
    async rebaseAuthoritative(_reason) {
      // Unlike schema/generation recovery, poison repair must not flush later
      // valid rows before the rejected optimistic state has been removed. A
      // pull that already passed Task 1's pending-id guard must finish first;
      // otherwise its stale window could apply after the full snapshot and
      // move the cursor/state backwards.
      authoritativeRepair = "poison";
      queue.pause("recovery");
      await (pulling ?? Promise.resolve());
      await runRecovery("rebase", {
        flush: false, resume: false, reportReplicaFailure: false,
      });
    },
    completeAuthoritativeRepair(reason) {
      if (authoritativeRepair === reason) authoritativeRepair = null;
    },
  };
}
