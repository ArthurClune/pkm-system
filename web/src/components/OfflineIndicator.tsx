// pattern: Imperative Shell
// Replaces the read-only reconnect banner (pkm-y8p0): offline editing
// stays enabled, so the indicator just reports state — "offline, N changes
// pending" while disconnected, a brief syncing note while the queue
// drains after reconnect, nothing when clean.
import { useEffect, useState } from "react";
import { useSync } from "../sync/SyncProvider";

export function OfflineIndicator() {
  const { status, canEdit, pending, readOnlyReason, problem,
          retryProblem, dismissProblem } = useSync();
  const [syncingAfterReconnect, setSyncingAfterReconnect] =
    useState(status !== "connected");

  useEffect(() => {
    if (status !== "connected") setSyncingAfterReconnect(true);
    else if (pending === 0) setSyncingAfterReconnect(false);
  }, [status, pending]);

  const deliveryProblem = problem === undefined ? null : (
    <div className="ws-banner" role={problem.repair === "failed" ? "alert" : "status"}>
      {problem.repair === "running" ? (
        <>Server rejected a change (HTTP {problem.event.status}). Repairing local state…</>
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
  );

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
  return <>{deliveryProblem}{connectivity}</>;
}
