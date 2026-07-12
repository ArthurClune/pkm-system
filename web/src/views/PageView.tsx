// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BacklinksSection } from "../components/BacklinksSection";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { UnlinkedSection } from "../components/UnlinkedSection";
import { encodeTitle, titleFromPathname } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

export function PageView() {
  const { pathname } = useLocation();
  const title = titleFromPathname(pathname);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const token = ++seqRef.current;
    setError(null);
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (token === seqRef.current) setPayload(p); })
      .catch((e: unknown) => {
        if (token === seqRef.current) setError(String(e));
      });
  }, [title]);

  useEffect(() => { setPayload(null); load(); }, [load]);
  useResync(load); // rejected batch or reconnect: refetch authoritative state
  useEffect(() => { document.title = `${title} — pkm`; }, [title]);

  if (error) return <p className="error">Could not load "{title}": {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefProvider seed={payload.block_ref_texts}>
      <article className="page">
        <h1 className="page-title">{payload.page.title}</h1>
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} composer />
      </article>
      <BacklinksSection key={`bl-${title}`} title={title} initial={payload.backlinks} />
      <UnlinkedSection key={`ul-${title}`} title={title} />
    </BlockRefProvider>
  );
}
