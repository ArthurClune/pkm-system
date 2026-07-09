// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { encodeTitle } from "../paths";
import { BlockTree } from "./BlockTree";
import { PageLink } from "./PageLink";

export function SidebarPanel({ title, onClose }:
    { title: string; onClose: () => void }) {
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title]);

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
        <BlockRefContext.Provider value={payload.block_ref_texts}>
          <BlockTree blocks={payload.blocks} />
        </BlockRefContext.Provider>
      )}
    </section>
  );
}
