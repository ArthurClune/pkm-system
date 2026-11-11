// pattern: Imperative Shell
import type { RawTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { OutlineReplayAction } from "../outline/outlineState";
import type { Replica } from "../replica/client";
import { ReplicaUnusableError } from "../replica/errors";
import type { WriteTicket } from "./opQueue";
import type { WsBatch } from "./socket";

/** Everything callable. One object for the provider's whole lifetime: every
 * outline keeps it in the dependencies of its handlers, its edit runner and
 * its DnD api, so a new identity here re-renders every mounted Journal day.
 * Each method reads the freshest state through a ref rather than
 * closing over rendered state, which is what makes that possible. */
export interface SyncActions {
  /** Retry the retained rejected-batch repair, if it failed. */
  retryProblem(): Promise<void>;
  /** Clear repaired details. Failed/running problems cannot be dismissed. */
  dismissProblem(): void;
  /** Give up on a mark-failed rejected batch: drop its retained intents and
   * release the recovery barrier they held. The escape from a
   * profile whose replica can never open — without it the intent can never
   * clear and every future session boots wedged. Safe to give up because the
   * unmarked batch redelivers if the replica ever opens again, and the server
   * rejects it back into the normal poison → repair flow. */
  discardProblem(): Promise<void>;
  /** Manual recovery for a stalled replica (Fix A): flushes pending writes
   * then rebuilds from a fresh snapshot. Pass discardPending=true to proceed
   * even when the flush cannot be delivered. */
  resetReplica(discardPending?: boolean): Promise<void>;
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
  attachOutlineReplay(ticket: WriteTicket, title: RawTitle,
                      replay: readonly OutlineReplayAction[]): void;
  /** Remote batches only — own echoes are filtered out here. */
  subscribe(fn: (batch: WsBatch) => void): () => void;
  /** Resolves when all accepted writes have finished persistence. */
  settled(): Promise<void>;
}

/** The queue always has a Replica; where there is none, this reports the same
 * permanent unavailability the worker reports for a database it could not open.
 * The queue latches that once and answers it by delivering online-only through
 * its in-memory lane — which is what a browser with no usable OPFS
 * already does, so "no replica at all" needs no second delivery path. Reachable
 * only where `Worker` is undefined (jsdom) or a test passes `replica={null}`; a
 * real browser always builds the worker-backed replica (SyncProvider's
 * defaultReplica). */
export function absentReplica(): Replica {
  const absent = async (): Promise<never> => {
    throw new ReplicaUnusableError("no replica in this environment");
  };
  return {
    init: absent, applySnapshot: absent, applyChanges: absent,
    enqueue: absent, nextBatch: absent, pendingBatches: absent,
    poisonedBatches: absent, deleteBatch: absent, markPoisoned: absent,
    pendingCount: absent, localApi: absent, prepareRecovery: absent,
    commitRecovery: absent, abortRecovery: absent,
    diagnostics: absent, dispose: absent,
  };
}
