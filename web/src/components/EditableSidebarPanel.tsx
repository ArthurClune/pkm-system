// pattern: Imperative Shell
// Fetches one page for a sidebar panel and renders it through EditablePage
// — the same useOutline machinery, op queue, and live websocket sync as the
// main pane, instead of the old one-shot read-only fetch. (EditablePage
// itself handles the case where this title is already open elsewhere in
// the tab, falling back to read-only there.)
//
// An optional uid (pkm-gdi5, a block ref or asset link opened with
// shift-click) is scrolled to and flashed once the page has rendered --
// scoped to this panel's OWN container via containerRef, never a
// document-wide query: the same page can be open in the main window at
// the same time, with its own element carrying that data-uid.
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { encodeTitle } from "../paths";
import {
  acquireOutlineSession,
  type ParentReadiness,
  type ReadToken,
} from "../outline/outlineSessions";
import { EditablePage } from "../views/EditablePage";

export function EditableSidebarPanel({ title, uid }: { title: string; uid?: string }) {
  const [payloadState, setPayloadState] = useState<{
    title: string;
    payload: PagePayload;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [errorState, setErrorState] = useState<{
    title: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const session = acquireOutlineSession(title, null);
    let current: {
      token: ReadToken;
      generation: number;
      readiness: ParentReadiness;
    } | null = null;
    const removeLoader = session.setAuthoritativeLoader(async () => {
      const page = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(title)}`,
      );
      return page.blocks;
    });

    const start = () => {
      if (cancelled) return;
      const readGeneration = ++generation;
      if (current) {
        current.readiness.release();
        session.cancelAuthoritativeRead(current.token);
      }
      const token = session.beginAuthoritativeRead("parent");
      const readiness = session.registerParentReadiness(token);
      current = { token, generation: readGeneration, readiness };
      setErrorState(null);
      void readiness.promise
        .then((winner) => {
          if (cancelled || readGeneration !== generation) return;
          if (current?.token === token) current = null;
          setErrorState(null);
          setPayloadState({
            title,
            payload: { ...winner, blocks: session.getSnapshot().blocks },
          });
        })
        .catch((winnerError: unknown) => {
          if (!cancelled && readGeneration === generation) {
            if (current?.token === token) current = null;
            setErrorState({ title, message: String(winnerError) });
          }
        });
      apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
        .then((p) => {
          if (cancelled || readGeneration !== generation) {
            readiness.release();
            session.cancelAuthoritativeRead(token);
            return;
          }
          const accepted = session.receiveParentAuthoritative(token, p);
          if (accepted && current?.token === token) current = null;
        })
        .catch((e: unknown) => {
          session.failAuthoritativeRead(token, e);
        });
    };

    const removeParentController = session.setParentReadController(start);
    start();
    return () => {
      cancelled = true;
      generation += 1;
      current?.readiness.release();
      removeParentController();
      if (current) session.cancelAuthoritativeRead(current.token);
      removeLoader();
      session.release();
    };
  }, [title]);

  const payload = payloadState?.title === title ? payloadState.payload : null;
  const error = errorState?.title === title ? errorState.message : null;

  useEffect(() => {
    if (!payload || !uid) return;
    const container = containerRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash-target");
    const t = setTimeout(() => el.classList.remove("flash-target"), 1600);
    return () => clearTimeout(t);
  }, [payload, uid]);

  if (error) return <p className="error">{error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <div ref={containerRef}>
      <BlockRefContext.Provider value={payload.block_ref_texts}>
        <EditablePage title={title} initial={payload.blocks} />
      </BlockRefContext.Provider>
    </div>
  );
}
