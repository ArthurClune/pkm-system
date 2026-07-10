// pattern: Imperative Shell
// Fetches one page for a sidebar panel and renders it through EditablePage
// — the same useOutline machinery, op queue, and live websocket sync as the
// main pane, instead of the old one-shot read-only fetch. (EditablePage
// itself handles the case where this title is already open elsewhere in
// the tab, falling back to read-only there.)
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { encodeTitle } from "../paths";
import { EditablePage } from "../views/EditablePage";

export function EditableSidebarPanel({ title }: { title: string }) {
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title]);

  if (error) return <p className="error">{error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefContext.Provider value={payload.block_ref_texts}>
      <EditablePage title={title} initial={payload.blocks} />
    </BlockRefContext.Provider>
  );
}
