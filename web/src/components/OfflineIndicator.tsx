// pattern: Imperative Shell
// Replaces the read-only reconnect banner (pkm-y8p0): offline editing
// stays enabled, so the indicator just reports state — "offline, N changes
// pending" while disconnected, a brief syncing note while the queue
// drains after reconnect, nothing when clean.
import { useEffect, useState } from "react";
import { useSync } from "../sync/SyncProvider";

export function OfflineIndicator() {
  const { status, canEdit, pending, readOnlyReason } = useSync();
  const [syncingAfterReconnect, setSyncingAfterReconnect] =
    useState(status !== "connected");

  useEffect(() => {
    if (status !== "connected") setSyncingAfterReconnect(true);
    else if (pending === 0) setSyncingAfterReconnect(false);
  }, [status, pending]);

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
