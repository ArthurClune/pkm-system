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
import { acquireOutlineSession,
         type AuthoritativeReadSource,
         type OutlineSessionHandle,
         type ReadToken } from "../outline/outlineSessions";
import { EditablePage } from "./EditablePage";

export function PageView() {
  const { pathname, hash } = useLocation();
  const title = titleFromPathname(pathname);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);
  const sessionRef = useRef<OutlineSessionHandle | null>(null);
  const readRef = useRef<{
    handle: OutlineSessionHandle;
    token: ReadToken;
  } | null>(null);

  const load = useCallback((source: AuthoritativeReadSource,
                            handle = sessionRef.current) => {
    if (!handle) return;
    const seq = ++seqRef.current;
    const previous = readRef.current;
    if (previous) previous.handle.cancelAuthoritativeRead(previous.token);
    const token = handle.beginAuthoritativeRead(source);
    const read = { handle, token };
    readRef.current = read;
    setError(null);
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => {
        if (seq !== seqRef.current) {
          handle.cancelAuthoritativeRead(token);
          return;
        }
        handle.receiveAuthoritative(token, p.blocks);
        if (readRef.current === read) readRef.current = null;
        setPayload({ ...p, blocks: handle.getSnapshot().blocks });
      })
      .catch((e: unknown) => {
        handle.cancelAuthoritativeRead(token);
        if (readRef.current === read) readRef.current = null;
        if (seq === seqRef.current) setError(String(e));
      });
  }, [title]);

  useEffect(() => {
    setPayload(null);
    const handle = acquireOutlineSession(title, null);
    sessionRef.current = handle;
    const removeLoader = handle.setAuthoritativeLoader(async () => {
      const page = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(title)}`,
      );
      return page.blocks;
    });
    load("parent", handle);
    return () => {
      seqRef.current += 1;
      const read = readRef.current;
      if (read?.handle === handle) {
        handle.cancelAuthoritativeRead(read.token);
        readRef.current = null;
      }
      removeLoader();
      if (sessionRef.current === handle) sessionRef.current = null;
      handle.release();
    };
  }, [load, title]);
  const resync = useCallback(() => load("resync"), [load]);
  useResync(resync); // rejected batch or reconnect: guarded authoritative read
  useEffect(() => { document.title = `${title} — pkm`; }, [title]);

  // A block ref navigated here with the target uid as the hash (pkm-pzdu):
  // once the payload has rendered, scroll to that block and flash it. A uid
  // not on the page (deleted, or inside a collapsed subtree) is a no-op.
  useEffect(() => {
    if (!payload || hash.length < 2) return;
    const el = document.querySelector(`[data-uid="${CSS.escape(hash.slice(1))}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash-target");
    const t = setTimeout(() => el.classList.remove("flash-target"), 1600);
    return () => clearTimeout(t);
  }, [payload, hash]);

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
