// pattern: Imperative Shell
// Replaces the read-only reconnect banner (pkm-y8p0): offline editing
// stays enabled, so the indicator just reports state — "offline, N changes
// pending" while disconnected, a brief syncing note while the queue
// drains after reconnect, nothing when clean.
import { useEffect, useState } from "react";
import { useSync } from "../sync/SyncProvider";
import { useConfirm } from "./ConfirmDialog";

export function OfflineIndicator() {
  const { status, canEdit, pending, readOnlyReason, problem,
          retryProblem, dismissProblem, discardProblem,
          resetReplica } = useSync();
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

  const deliveryProblem = problem === undefined ? null
    : problem.kind === "poison-discovery" ? (
      <div className="ws-banner" role="alert">
        Checking rejected changes failed: {problem.error}
        <button type="button" onClick={() => { void retryProblem(); }}>Retry</button>
      </div>
    ) : problem.kind === "replica-unavailable" ? (
      // Reload, not Retry: the worker latches a failed open for the session
      // (pkm-bjae), and by now the queue has already delivered online, so
      // reopening mid-session could flush a previous session's stale durable
      // queue on top of those writes. A fresh page load gets a fresh worker
      // and runs startup's poison discovery in the right order.
      // The second sentence turns on connectivity, because the truth does
      // (pkm-s1m8). This problem is a ReplicaUnavailableError (SyncProvider
      // only raises replica-unavailable for availabilityOf(error) ===
      // "unusable"), which is never `rejected`, so opQueue always retains
      // here — but retained ops live in the in-memory fallback lane. So "still
      // being saved" is true while the socket is up and delivering, and false
      // the moment it is not: a refresh or a closed tab then takes them. The
      // copy stays conditional even with useUnloadGuard installed, because the
      // guard does not hold on iPad (pkm-0htf), so the unconditional
      // reassurance would be a promise we cannot keep there. Offline with
      // nothing pending there is neither a promise to make nor a loss to warn
      // about, so the first sentence stands alone.
      <div className="ws-banner" role="status">
        Working online only — offline editing is unavailable for now.
        {status === "connected"
          ? " Your changes are still being saved to the server."
          : pending > 0
            ? ` You are offline: ${pending} unsent change`
              + `${pending === 1 ? " exists" : "s exist"} only in memory here. `
              + `Reloading or closing this tab discards ${
                pending === 1 ? "it" : "them"}.`
            : null}
        <button type="button" onClick={() => { void reloadForOnlineOnly(); }}>
          Reload
        </button>
      </div>
    ) : problem.kind === "legacy-rejected" ? (
      <div className="ws-banner" role={
        problem.repair === "failed" ? "alert" : "status"
      }>
        {problem.repair === "running" ? (
          <>Server rejected a change. Repairing active outlines…</>
        ) : problem.repair === "failed" ? (
          <>Server rejected a change: {problem.error}.{" "}
            Authoritative repair failed: {problem.repairError}
            <button type="button" onClick={() => { void retryProblem(); }}>
              Retry
            </button>
          </>
        ) : (
          <>Server rejected a change. Active outlines repaired.
            <button type="button" onClick={dismissProblem}>Dismiss</button>
          </>
        )}
      </div>
    ) : problem.kind === "rejected-batch" ? (
    <div className="ws-banner" role={
      problem.repair === "failed" || problem.repair === "mark-failed"
        ? "alert" : "status"
    }>
      {problem.repair === "running" ? (
        // The repair rebuilds the whole replica from a snapshot, and iOS
        // freezes a backgrounded PWA mid-rebuild; each relaunch then starts
        // over, which reads as sync being stuck forever (pkm-a1gh).
        <>Server rejected a change (HTTP {problem.event.status}).
          {" "}Repairing local state… Keep the app open until this finishes.</>
      ) : problem.repair === "mark-failed" ? (
        // Retry cannot succeed while the replica stays unopenable, and the
        // retained intent it retries wedges every future session with it.
        // Discard is the escape (pkm-tu5k): the rejected change is already
        // lost server-side, so giving up on marking it loses nothing more.
        <>Server rejected a change (HTTP {problem.event.status}): {problem.event.message}.{" "}
          Saving rejected-change recovery failed: {problem.error}
          <button type="button" onClick={() => { void retryProblem(); }}>Retry</button>
          <button type="button" onClick={() => { void discardProblem(); }}>
            Discard rejected change
          </button>
        </>
      ) : problem.repair === "failed" ? (
        <>Server rejected a change (HTTP {problem.event.status}): {problem.event.message}.{" "}
          Local repair failed: {problem.error}
          <button type="button" onClick={() => { void retryProblem(); }}>Retry</button>
        </>
      ) : (
        <>Server rejected a change (HTTP {problem.event.status}): {problem.event.message}.{" "}
          Local state repaired.
          <button type="button" onClick={dismissProblem}>Dismiss</button>
        </>
      )}
      <details>
        <summary>Details</summary>
        <div>Batch {problem.event.batchId}</div>
        <pre>{JSON.stringify(problem.event.ops, null, 2)}</pre>
      </details>
    </div>
    ) : problem.kind === "replica-stalled" ? (
      <div className="ws-banner" role="alert">
        {problem.reset === "blocked" ? (
          <>{problem.pending} unsent change{problem.pending === 1 ? "" : "s"} could
            not be delivered.{" "}
            <button type="button" onClick={() => { void resetReplica(true); }}>
              Discard and reset
            </button>
            <button type="button" onClick={dismissProblem}>Keep waiting</button>
          </>
        ) : (
          <>Local sync is stuck: {problem.error}{" "}
            {problem.reset === "failed" && <>Reset failed: {problem.resetError}.{" "}</>}
            <button type="button" disabled={problem.reset === "running"}
                    onClick={() => { void resetReplica(false); }}>
              Reset local data
            </button>
          </>
        )}
      </div>
    ) : null;

  let connectivity = null;
  if (status === "connected") {
    if (syncingAfterReconnect && pending > 0) connectivity = (
      <div className="ws-banner" role="status">
        Syncing — {pending} change{pending === 1 ? "" : "s"} pending…
      </div>
    );
  } else if (!canEdit) {
    connectivity = (
      <div className="ws-banner" role="status">
        Offline — editing paused: {readOnlyReason}
      </div>
    );
  } else {
    connectivity = (
      <div className="ws-banner" role="status">
        Offline — {pending === 0 ? "changes will sync on reconnect"
          : `${pending} change${pending === 1 ? "" : "s"} pending`}
      </div>
    );
  }
  return <>{deliveryProblem}{connectivity}{dialog}</>;
}
