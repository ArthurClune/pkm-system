// pattern: Imperative Shell
// Replaces the read-only reconnect banner (pkm-y8p0): offline editing
// stays enabled, so the indicator just reports state — "offline, N changes
// pending" while disconnected, a brief syncing note while the queue
// drains after reconnect, nothing when clean.
//
// Two independent banners, in this order: a delivery-health banner (one
// component per SyncProblem kind below, dispatched exhaustively) and the
// connectivity banner. `role="alert"` is reserved for states the user must act
// on — a failed repair, a failed durable mark, a stalled replica; everything
// else is `role="status"`.
import { useEffect, useState } from "react";
import { useSyncActions, useSyncEditability, useSyncHealth,
         type SyncProblem, type SyncStatus } from "../sync/SyncProvider";
import { useConfirm } from "./ConfirmDialog";

type ProblemOf<K extends SyncProblem["kind"]> = Extract<SyncProblem, { kind: K }>;

/** Actions the delivery banners can offer. Which of them a given problem
 * state actually shows is the banner's own business; the provider decides
 * what each one means (SyncProvider.retryProblem / retryPolicy.ts). */
interface BannerActions {
  retry: () => void;
  dismiss: () => void;
  discard: () => void;
  reset: (discardPending: boolean) => void;
  reload: () => void;
}

function PoisonDiscoveryBanner({ problem, actions }: {
  problem: ProblemOf<"poison-discovery">;
  actions: BannerActions;
}) {
  return (
    <div className="ws-banner" role="alert">
      Checking rejected changes failed: {problem.error}
      <button type="button" onClick={actions.retry}>Retry</button>
    </div>
  );
}

/** The second sentence turns on connectivity, because the truth does
 * (pkm-s1m8). This problem is a ReplicaUnavailableError (SyncProvider only
 * raises replica-unavailable for availabilityOf(error) === "unusable"), which
 * is never `rejected`, so opQueue always retains here — but retained ops live
 * in the in-memory fallback lane. So "still being saved" is true while the
 * socket is up and delivering, and false the moment it is not: a refresh or a
 * closed tab then takes them. The copy stays conditional even with
 * useUnloadGuard installed, because the guard does not hold on iPad
 * (pkm-0htf), so the unconditional reassurance would be a promise we cannot
 * keep there. Offline with nothing pending is neither a promise to make nor a
 * loss to warn about, so the first sentence stands alone. */
function onlineOnlySafetyCopy(status: SyncStatus, pending: number): string | null {
  if (status === "connected") {
    return " Your changes are still being saved to the server.";
  }
  if (pending === 0) return null;
  return ` You are offline: ${pending} unsent change`
    + `${pending === 1 ? " exists" : "s exist"} only in memory here. `
    + `Reloading or closing this tab discards ${pending === 1 ? "it" : "them"}.`;
}

function ReplicaUnavailableBanner({ status, pending, actions }: {
  status: SyncStatus;
  pending: number;
  actions: BannerActions;
}) {
  // Reload, not Retry: the worker latches a failed open for the session
  // (pkm-bjae), and by now the queue has already delivered online, so
  // reopening mid-session could flush a previous session's stale durable
  // queue on top of those writes. A fresh page load gets a fresh worker
  // and runs startup's poison discovery in the right order.
  return (
    <div className="ws-banner" role="status">
      Working online only — offline editing is unavailable for now.
      {onlineOnlySafetyCopy(status, pending)}
      <button type="button" onClick={actions.reload}>
        Reload
      </button>
    </div>
  );
}

function LegacyRejectedMessage({ problem, actions }: {
  problem: ProblemOf<"legacy-rejected">;
  actions: BannerActions;
}) {
  switch (problem.repair) {
    case "running":
      return <>Server rejected a change. Repairing active outlines…</>;
    case "failed":
      return (
        <>Server rejected a change: {problem.error}.{" "}
          Authoritative repair failed: {problem.repairError}
          <button type="button" onClick={actions.retry}>
            Retry
          </button>
        </>
      );
    case "repaired":
      return (
        <>Server rejected a change. Active outlines repaired.
          <button type="button" onClick={actions.dismiss}>Dismiss</button>
        </>
      );
  }
}

function LegacyRejectedBanner({ problem, actions }: {
  problem: ProblemOf<"legacy-rejected">;
  actions: BannerActions;
}) {
  return (
    <div className="ws-banner" role={
      problem.repair === "failed" ? "alert" : "status"
    }>
      <LegacyRejectedMessage problem={problem} actions={actions} />
    </div>
  );
}

function RejectedBatchMessage({ problem, actions }: {
  problem: ProblemOf<"rejected-batch">;
  actions: BannerActions;
}) {
  switch (problem.repair) {
    case "running":
      // The repair rebuilds the whole replica from a snapshot, and iOS
      // freezes a backgrounded PWA mid-rebuild; each relaunch then starts
      // over, which reads as sync being stuck forever (pkm-a1gh).
      return (
        <>Server rejected a change (HTTP {problem.event.status}).
          {" "}Repairing local state… Keep the app open until this finishes.</>
      );
    case "mark-failed":
      // Retry cannot succeed while the replica stays unopenable, and the
      // retained intent it retries wedges every future session with it.
      // Discard is the escape (pkm-tu5k): the rejected change is already
      // lost server-side, so giving up on marking it loses nothing more.
      return (
        <>Server rejected a change (HTTP {problem.event.status}): {problem.event.message}.{" "}
          Saving rejected-change recovery failed: {problem.error}
          <button type="button" onClick={actions.retry}>Retry</button>
          <button type="button" onClick={actions.discard}>
            Discard rejected change
          </button>
        </>
      );
    case "failed":
      return (
        <>Server rejected a change (HTTP {problem.event.status}): {problem.event.message}.{" "}
          Local repair failed: {problem.error}
          <button type="button" onClick={actions.retry}>Retry</button>
        </>
      );
    case "repaired":
      return (
        <>Server rejected a change (HTTP {problem.event.status}): {problem.event.message}.{" "}
          Local state repaired.
          <button type="button" onClick={actions.dismiss}>Dismiss</button>
        </>
      );
  }
}

function RejectedBatchBanner({ problem, actions }: {
  problem: ProblemOf<"rejected-batch">;
  actions: BannerActions;
}) {
  return (
    <div className="ws-banner" role={
      problem.repair === "failed" || problem.repair === "mark-failed"
        ? "alert" : "status"
    }>
      <RejectedBatchMessage problem={problem} actions={actions} />
      <details>
        <summary>Details</summary>
        <div>Batch {problem.event.batchId}</div>
        <pre>{JSON.stringify(problem.event.ops, null, 2)}</pre>
      </details>
    </div>
  );
}

function ReplicaStalledBanner({ problem, actions }: {
  problem: ProblemOf<"replica-stalled">;
  actions: BannerActions;
}) {
  return (
    <div className="ws-banner" role="alert">
      {problem.reset === "blocked" ? (
        <>{problem.pending} unsent change{problem.pending === 1 ? "" : "s"} could
          not be delivered.{" "}
          <button type="button" onClick={() => { actions.reset(true); }}>
            Discard and reset
          </button>
          <button type="button" onClick={actions.dismiss}>Keep waiting</button>
        </>
      ) : (
        <>Local sync is stuck: {problem.error}{" "}
          {problem.reset === "failed" && <>Reset failed: {problem.resetError}.{" "}</>}
          <button type="button" disabled={problem.reset === "running"}
                  onClick={() => { actions.reset(false); }}>
            Reset local data
          </button>
        </>
      )}
    </div>
  );
}

/** One banner per problem kind, dispatched exhaustively: a new SyncProblem
 * kind fails to typecheck here rather than rendering nothing. */
function DeliveryProblemBanner({ problem, status, pending, actions }: {
  problem: SyncProblem;
  status: SyncStatus;
  pending: number;
  actions: BannerActions;
}) {
  switch (problem.kind) {
    case "poison-discovery":
      return <PoisonDiscoveryBanner problem={problem} actions={actions} />;
    case "replica-unavailable":
      return <ReplicaUnavailableBanner status={status} pending={pending}
                                       actions={actions} />;
    case "legacy-rejected":
      return <LegacyRejectedBanner problem={problem} actions={actions} />;
    case "rejected-batch":
      return <RejectedBatchBanner problem={problem} actions={actions} />;
    case "replica-stalled":
      return <ReplicaStalledBanner problem={problem} actions={actions} />;
  }
}

function ConnectivityBanner({ status, canEdit, pending, readOnlyReason,
                              syncingAfterReconnect }: {
  status: SyncStatus;
  canEdit: boolean;
  pending: number;
  readOnlyReason?: string;
  syncingAfterReconnect: boolean;
}) {
  if (status === "connected") {
    if (!syncingAfterReconnect || pending === 0) return null;
    return (
      <div className="ws-banner" role="status">
        Syncing — {pending} change{pending === 1 ? "" : "s"} pending…
      </div>
    );
  }
  if (!canEdit) {
    return (
      <div className="ws-banner" role="status">
        Offline — editing paused: {readOnlyReason}
      </div>
    );
  }
  return (
    <div className="ws-banner" role="status">
      Offline — {pending === 0 ? "changes will sync on reconnect"
        : `${pending} change${pending === 1 ? "" : "s"} pending`}
    </div>
  );
}

export function OfflineIndicator() {
  const { status, pending, problem } = useSyncHealth();
  const { canEdit, readOnlyReason } = useSyncEditability();
  const { retryProblem, dismissProblem, discardProblem,
          resetReplica } = useSyncActions();
  const { confirm, dialog } = useConfirm();

  // A reload destroys the in-memory fallback lane, which in an online-only
  // session is the only place undelivered ops live. Ask first, the way
  // resetReplica does (pkm-bjae review). useUnloadGuard now covers this button
  // too, but it does not replace this confirm: beforeunload is unreliable in an
  // iOS standalone PWA, and this wording says what is actually at stake
  // (pkm-0htf).
  const reloadForOnlineOnly = async (): Promise<void> => {
    if (pending > 0) {
      const ok = await confirm(
        `${pending} unsent change${pending === 1 ? "" : "s"} ` +
        "have not reached the server yet. Reloading now discards them.",
        { confirmLabel: "Discard and reload", danger: true });
      if (!ok) return;
    }
    globalThis.location.reload();
  };
  const [syncingAfterReconnect, setSyncingAfterReconnect] =
    useState(status !== "connected");

  useEffect(() => {
    if (status !== "connected") setSyncingAfterReconnect(true);
    else if (pending === 0) setSyncingAfterReconnect(false);
  }, [status, pending]);

  const actions: BannerActions = {
    retry: () => { void retryProblem(); },
    dismiss: dismissProblem,
    discard: () => { void discardProblem(); },
    reset: (discardPending) => { void resetReplica(discardPending); },
    reload: () => { void reloadForOnlineOnly(); },
  };

  return (
    <>
      {problem !== undefined && (
        <DeliveryProblemBanner problem={problem} status={status}
                               pending={pending} actions={actions} />
      )}
      <ConnectivityBanner status={status} canEdit={canEdit} pending={pending}
                          readOnlyReason={readOnlyReason}
                          syncingAfterReconnect={syncingAfterReconnect} />
      {dialog}
    </>
  );
}
