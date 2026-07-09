// pattern: Imperative Shell
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { useDnd } from "../dnd/DndContext";
import { useDropZone } from "../dnd/useDropZone";
import { encodeTitle } from "../paths";
import { useSync } from "../sync/SyncProvider";
import { BlockTree } from "./BlockTree";
import { PageLink } from "./PageLink";

export function SidebarPanel({ title, onClose }:
    { title: string; onClose: () => void }) {
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshSeq, setRefreshSeq] = useState(0);
  const dnd = useDnd();
  const connected = useSync().status === "connected";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const payloadRef = useRef(payload);
  payloadRef.current = payload;
  const { indicator, zoneProps } = useDropZone(
    title, () => payloadRef.current?.blocks ?? [], containerRef);

  useEffect(() => dnd.registerPanel(title, () => setRefreshSeq((n) => n + 1)),
            [dnd, title]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title, refreshSeq]);

  return (
    <section className="sidebar-panel" aria-label={`sidebar: ${title}`}>
      <header className="sidebar-panel-header">
        <h2 className="sidebar-panel-title"><PageLink title={title} tag={false} /></h2>
        <button className="panel-close" onClick={onClose} aria-label="close panel">
          ×
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {!payload && !error && <p className="loading">Loading…</p>}
      {payload && (
        <div ref={containerRef} style={{ position: "relative" }}
             {...(connected ? zoneProps : {})} onDragEnd={() => dnd.endDrag()}>
          <BlockRefContext.Provider value={payload.block_ref_texts}>
            <BlockTree blocks={payload.blocks} dndPage={connected ? title : undefined} />
          </BlockRefContext.Provider>
          {indicator && (
            <div className="drop-indicator"
                 style={{ top: indicator.top, left: indicator.left }} />
          )}
        </div>
      )}
    </section>
  );
}
