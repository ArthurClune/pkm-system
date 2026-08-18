// pattern: Imperative Shell
// Popovers for /files cards (pkm-vcn6): which blocks reference an asset,
// and its description / describe error. Chrome, clamping and dismissal come
// from the shared Popover shell.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/typedClient";
import type { BacklinkGroup } from "../api/payloads";
import { BacklinkGroupList } from "../components/BacklinkGroupList";
import { InertMediaContext } from "../contexts";
import { pagePath } from "../paths";
import { Popover } from "../Popover";
import { refGroups, refUidChunks } from "./filesCore";
import type { AssetRef } from "./filesCore";

export function FileRefsPopover({ refs, x, y, onClose }: {
  refs: readonly AssetRef[]; x: number; y: number; onClose: () => void;
}) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState<BacklinkGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGroups(null);
    setError(null);
    Promise.all(refUidChunks(refs).map((uids) =>
      apiGet("/api/block-refs", { query: { uids: uids.join(",") } })))
      .then((payloads) => {
        if (cancelled) return;
        const texts = Object.assign(
          {}, ...payloads.map((p) => p.block_ref_texts));
        setGroups(refGroups(refs, texts));
      })
      .catch((fetchFailure: unknown) => {
        // Text is decoration; the refs themselves came with the search
        // payload, so degrade to placeholder rows instead of nothing.
        if (cancelled) return;
        setError(String(fetchFailure));
        setGroups(refGroups(refs, {}));
      });
    return () => { cancelled = true; };
  }, [refs]);

  return (
    <Popover label="References" x={x} y={y} onClose={onClose}
             remeasure={[groups, error]}>
      {error !== null && (
        <p className="error">Could not load block text: {error}</p>
      )}
      {groups === null && error === null && (
        <p className="loading">Loading…</p>
      )}
      {groups !== null && (
        <InertMediaContext.Provider value={true}>
          <BacklinkGroupList groups={groups}
            onNavigate={(pageTitle, uid) => {
              onClose();
              navigate(`${pagePath(pageTitle)}#${uid}`);
            }} />
        </InertMediaContext.Provider>
      )}
    </Popover>
  );
}

export function FileDescriptionPopover({ label, text, x, y, onClose }: {
  label: string; text: string; x: number; y: number; onClose: () => void;
}) {
  return (
    <Popover label={label} x={x} y={y} onClose={onClose}
             remeasure={[text]}>
      <p className="file-popover-text">{text}</p>
    </Popover>
  );
}
