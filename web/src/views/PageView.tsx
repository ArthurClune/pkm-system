// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockTree } from "../components/BlockTree";
import { BlockRefContext } from "../contexts";
import { encodeTitle, titleFromPathname } from "../paths";

export function PageView() {
  const { pathname } = useLocation();
  const title = titleFromPathname(pathname);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setError(null);
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => { if (!cancelled) setPayload(p); })
      .catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [title]);

  useEffect(() => {
    document.title = `${title} — pkm`;
  }, [title]);

  if (error) return <p className="error">Could not load "{title}": {error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefContext.Provider value={payload.block_ref_texts}>
      <article className="page">
        <h1 className="page-title">{payload.page.title}</h1>
        <BlockTree blocks={payload.blocks} />
      </article>
    </BlockRefContext.Provider>
  );
}
