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
import {
  acquireOutlineSession,
  type ReadToken,
} from "../outline/outlineSessions";
import { EditablePage } from "../views/EditablePage";

export function EditableSidebarPanel({ title }: { title: string }) {
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let generation = 0;
    const session = acquireOutlineSession(title, null);
    let current: { token: ReadToken; generation: number } | null = null;
    const removeLoader = session.setAuthoritativeLoader(async () => {
      const page = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(title)}`,
      );
      return page.blocks;
    });

    const awaitAcceptedParent = (token: ReadToken, readGeneration: number) => {
      void session.waitForParentAuthoritative(token)
        .then((winner) => {
          if (cancelled || readGeneration !== generation) return;
          setError(null);
          setPayload({ ...winner, blocks: session.getSnapshot().blocks });
        })
        .catch((winnerError: unknown) => {
          if (!cancelled && readGeneration === generation) {
            setError(String(winnerError));
          }
        });
    };

    const start = () => {
      if (cancelled) return;
      const readGeneration = ++generation;
      if (current) session.cancelAuthoritativeRead(current.token);
      const token = session.beginAuthoritativeRead("parent");
      current = { token, generation: readGeneration };
      setError(null);
      apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
        .then((p) => {
          if (cancelled || readGeneration !== generation) {
            session.cancelAuthoritativeRead(token);
            return;
          }
          const accepted = session.receiveParentAuthoritative(token, p);
          if (current?.token === token) current = null;
          if (!accepted) {
            awaitAcceptedParent(token, readGeneration);
            return;
          }
          setPayload({ ...p, blocks: session.getSnapshot().blocks });
        })
        .catch((e: unknown) => {
          session.failAuthoritativeRead(token, e);
          if (current?.token === token) current = null;
          if (!cancelled && readGeneration === generation) {
            awaitAcceptedParent(token, readGeneration);
          }
        });
    };

    const removeParentController = session.setParentReadController(start);
    start();
    return () => {
      cancelled = true;
      generation += 1;
      removeParentController();
      if (current) session.cancelAuthoritativeRead(current.token);
      removeLoader();
      session.release();
    };
  }, [title]);

  if (error) return <p className="error">{error}</p>;
  if (!payload) return <p className="loading">Loading…</p>;
  return (
    <BlockRefContext.Provider value={payload.block_ref_texts}>
      <EditablePage title={title} initial={payload.blocks} />
    </BlockRefContext.Provider>
  );
}
