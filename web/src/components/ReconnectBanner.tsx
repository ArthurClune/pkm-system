// pattern: Functional Core
import { useSync } from "../sync/SyncProvider";

/** Shown only after a live connection drops; the first connect is silent. */
export function ReconnectBanner() {
  const { status } = useSync();
  if (status !== "reconnecting") return null;
  return <div className="ws-banner" role="status">Reconnecting… editing is paused</div>;
}
