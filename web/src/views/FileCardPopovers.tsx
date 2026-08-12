// pattern: Imperative Shell
// Popovers for /files cards (pkm-vcn6): which blocks reference an asset,
// and its description / describe error. Chrome, clamping, and dismissal
// follow BlockRefBacklinksPopover; mouse/touch-only by the accepted
// popover convention (pkm-3w2h).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet } from "../api/typedClient";
import type { BacklinkGroup } from "../api/payloads";
import { BacklinkGroupList } from "../components/BacklinkGroupList";
import { InertMediaContext } from "../contexts";
import { pagePath } from "../paths";
import { clampPopoverPosition } from "../popoverPosition";
import { refGroups, refUidChunks } from "./filesCore";
import type { AssetRef } from "./filesCore";

function CardPopover({ label, x, y, onClose, remeasure, children }: {
  label: string;
  x: number;
  y: number;
  onClose: () => void;
  /** Values whose change resizes the content (loading -> rows), so the
   * clamp re-runs; same trick as BlockRefBacklinksPopover. */
  remeasure: readonly unknown[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampPopoverPosition({
      x, y, width: rect.width, height: rect.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      margin: 12,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...remeasure]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="block-ref-popover" role="dialog" aria-label={label}
         ref={ref} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  );
}

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
    <CardPopover label="References" x={x} y={y} onClose={onClose}
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
    </CardPopover>
  );
}

export function FileDescriptionPopover({ label, text, x, y, onClose }: {
  label: string; text: string; x: number; y: number; onClose: () => void;
}) {
  return (
    <CardPopover label={label} x={x} y={y} onClose={onClose}
                 remeasure={[text]}>
      <p className="file-popover-text">{text}</p>
    </CardPopover>
  );
}
