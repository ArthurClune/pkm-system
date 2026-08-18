// pattern: Imperative Shell
// The badge's popover (pkm-d31f): who references this block. Fetches
// lazily on open (offline: the shim serves it identically); the badge
// count is payload-fresh, this list is live truth — no reconciliation.
// Chrome, clamping and dismissal come from the shared Popover shell.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/typedClient";
import type { BacklinkGroup } from "../api/payloads";
import { pagePath } from "../paths";
import { Popover } from "../Popover";
import { BacklinkGroupList } from "./BacklinkGroupList";

export function BlockRefBacklinksPopover({ uid, x, y, onClose }: {
  uid: string; x: number; y: number; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<BacklinkGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setError(null);
    apiGet("/api/block/{uid}/backlinks", { path: { uid } })
      .then((payload) => { if (!cancelled) setGroups(payload.groups); })
      .catch((fetchFailure: unknown) => {
        if (!cancelled) setError(String(fetchFailure));
      });
    return () => { cancelled = true; };
  }, [uid]);

  return (
    <Popover label="References" x={x} y={y} onClose={onClose}
             remeasure={[groups, error]}>
      {error !== null && <p className="error">Could not load references: {error}</p>}
      {error === null && groups === null && <p className="loading">Loading…</p>}
      {groups !== null && groups.length === 0 && (
        <p className="loading">No references — the badge may be stale.</p>
      )}
      {groups !== null && groups.length > 0 && (
        <BacklinkGroupList groups={groups}
          onNavigate={(pageTitle, itemUid) => {
            onClose();
            // same-page hash navigation may not unmount the tree, so close
            // explicitly first; PageView scrolls + flashes the hash target.
            navigate(`${pagePath(pageTitle)}#${itemUid}`);
          }} />
      )}
    </Popover>
  );
}
