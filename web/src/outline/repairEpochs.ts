// pattern: Imperative Shell
// The repair epoch: one global pass that forces every live outline through a
// post-settlement authoritative read before legacy delivery resumes. At most
// one epoch runs at a time, and while it runs it owns every session's reads —
// sessions ask `isRepairActive()` before starting one of their own and join
// `activeRepairCompletion()` instead.
//
// The epoch is a fixed-point loop, not a single pass: a session whose state
// moved while its own read was in flight (a remote batch, a later write) is
// repaired again, and a session acquired mid-epoch is enrolled on the next
// scan. It settles only when every live target's state matches the state its
// last accepted repair read produced.
//
// It knows nothing about sessions: `RepairTarget` is the whole vocabulary,
// which is what makes the loop testable without a session registry.

/** One session as the epoch sees it. Target objects must be stable across
 * passes — the epoch keys its per-target bookkeeping on identity. */
export interface RepairTarget {
  /** Identity of the currently published state. The epoch compares it with
   * the state its last accepted read produced; anything else means the
   * session moved and needs repairing again. */
  currentState(): unknown;
  /** Whether a handle still holds this session. */
  isActive(): boolean;
  /** Run one repair read. The synchronous part — superseding outstanding
   * tokens — must happen before this returns, so a stale in-flight response
   * can never publish under the epoch. Resolves with the state adopted, or
   * `null` when the response was rejected or the session went away; rejects
   * when the session cannot be repaired at all. */
  repairRead(): Promise<unknown>;
  /** Post-read bookkeeping (session collection). */
  settle(): void;
}

/** The registry the epoch scans. */
export interface RepairCohort {
  /** Every known target; the epoch filters for the live ones itself, and
   * re-scans between passes so mid-epoch arrivals are enrolled. */
  targets(): readonly RepairTarget[];
  /** Runs once the epoch has cleared, whether it settled or failed. */
  epochEnded(): void;
}

interface RepairEpoch {
  cohort: RepairCohort;
  repairedState: Map<RepairTarget, unknown>;
  inFlight: Map<RepairTarget, Promise<void>>;
  onStable: Set<() => void>;
  completion: Promise<void>;
}

let activeEpoch: RepairEpoch | null = null;

/** True while an epoch owns every session's authoritative reads. */
export function isRepairActive(): boolean {
  return activeEpoch !== null;
}

/** The running epoch's completion, or null. A session that wants a read while
 * an epoch runs joins this instead of starting one. */
export function activeRepairCompletion(): Promise<void> | null {
  return activeEpoch?.completion ?? null;
}

function repairTargetOnce(
  epoch: RepairEpoch,
  target: RepairTarget,
): Promise<void> {
  const current = epoch.inFlight.get(target);
  if (current) return current;
  const read = target.repairRead();
  const run = read
    .then((state) => {
      if (state !== null) epoch.repairedState.set(target, state);
    })
    .finally(() => {
      epoch.inFlight.delete(target);
      target.settle();
    });
  epoch.inFlight.set(target, run);
  return run;
}

function liveTargets(epoch: RepairEpoch): RepairTarget[] {
  return epoch.cohort.targets().filter((target) => target.isActive());
}

async function runRepairEpoch(epoch: RepairEpoch): Promise<void> {
  // Rejected delivery resolves before its settlement callbacks remove replay
  // data. Begin cohort selection only after those callbacks have run.
  await Promise.resolve();
  while (activeEpoch === epoch) {
    const pending = liveTargets(epoch).filter(
      (target) => epoch.repairedState.get(target) !== target.currentState(),
    );
    if (pending.length > 0) {
      await Promise.all(
        pending.map((target) => repairTargetOnce(epoch, target)),
      );
      continue;
    }

    // Let acquisitions/releases queued by the completed loaders run, then
    // rescan. The final callbacks (including queue resume) run synchronously
    // while this epoch is still active, closing the cohort/resume race.
    await Promise.resolve();
    const stable = liveTargets(epoch).every(
      (target) => epoch.repairedState.get(target) === target.currentState(),
    );
    if (!stable) continue;
    for (const callback of epoch.onStable) callback();
    return;
  }
}

/** Force every live target through a repair read and settle once none of them
 * has moved since its own repair. A concurrent call joins the running epoch
 * and adds its `onStable` callback to it. */
export function runRepair(
  cohort: RepairCohort,
  onStable?: () => void,
): Promise<void> {
  if (activeEpoch) {
    if (onStable) activeEpoch.onStable.add(onStable);
    return activeEpoch.completion;
  }
  const epoch: RepairEpoch = {
    cohort,
    repairedState: new Map(),
    inFlight: new Map(),
    onStable: new Set(onStable ? [onStable] : []),
    completion: Promise.resolve(),
  };
  activeEpoch = epoch;
  epoch.completion = runRepairEpoch(epoch).finally(() => {
    if (activeEpoch === epoch) activeEpoch = null;
    cohort.epochEnded();
  });
  return epoch.completion;
}
