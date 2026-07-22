// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { PagePayload } from "../api/payloads";
import { BacklinksSection } from "../components/BacklinksSection";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { PageTitle } from "../components/PageTitle";
import { UnlinkedSection } from "../components/UnlinkedSection";
import { encodeTitle, titleFromPathname } from "../paths";
import { dateForTitle } from "../replica/daily";
import { useResync } from "../sync/SyncProvider";
import { acquireOutlineSession,
         type AuthoritativeReadSource,
         type OutlineSessionHandle,
         type ParentReadiness,
         type ReadToken } from "../outline/outlineSessions";
import { EditablePage } from "./EditablePage";

// A non-today daily page 404s if nobody has written to it yet or it was
// pruned empty (server: GET /api/page auto-creates only today's daily,
// pkm-fy52). Render it as an empty editable page instead of an error — the
// first edit lazily creates the row via CreateOp's get_or_create.
const emptyDailyPayload = (title: string): PagePayload => ({
  page: { id: -1, title, created_at: 0, updated_at: 0 },
  blocks: [],
  backlinks: { groups: [], total_pages: 0, offset: 0, limit: 20 },
  block_ref_texts: {},
});

const missingDaily = (e: unknown, title: string): boolean =>
  e instanceof ApiError && e.status === 404 && dateForTitle(title) !== null;

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
    readiness: ParentReadiness | null;
  } | null>(null);

  const load = useCallback((source: AuthoritativeReadSource,
                            handle = sessionRef.current) => {
    if (!handle) return;
    const seq = ++seqRef.current;
    const previous = readRef.current;
    if (previous) {
      previous.readiness?.release();
      previous.handle.cancelAuthoritativeRead(previous.token);
    }
    const token = handle.beginAuthoritativeRead(source);
    const readiness = source === "parent"
      ? handle.registerParentReadiness(token)
      : null;
    const read = { handle, token, readiness };
    readRef.current = read;
    setError(null);
    if (readiness) {
      void readiness.promise
        .then((winner) => {
          if (seq !== seqRef.current) return;
          if (readRef.current === read) readRef.current = null;
          setError(null);
          setPayload({ ...winner, blocks: handle.getSnapshot().blocks });
        })
        .catch((winnerError: unknown) => {
          if (seq === seqRef.current) {
            if (readRef.current === read) readRef.current = null;
            setError(String(winnerError));
          }
        });
    }
    apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`)
      .then((p) => {
        if (seq !== seqRef.current) {
          readiness?.release();
          handle.cancelAuthoritativeRead(token);
          return;
        }
        const accepted = handle.receiveParentAuthoritative(token, p);
        if (readRef.current === read && (accepted || source !== "parent")) {
          readRef.current = null;
        }
        if (accepted && source !== "parent") {
          setPayload({ ...p, blocks: handle.getSnapshot().blocks });
        }
      })
      .catch((e: unknown) => {
        if (missingDaily(e, title)) {
          const p = emptyDailyPayload(title);
          const accepted = handle.receiveParentAuthoritative(token, p);
          if (readRef.current === read && (accepted || source !== "parent")) {
            readRef.current = null;
          }
          if (seq === seqRef.current && accepted && source !== "parent") {
            setPayload({ ...p, blocks: handle.getSnapshot().blocks });
          }
          return;
        }
        const owned = handle.failAuthoritativeRead(token, e);
        if (readRef.current === read && source !== "parent") {
          readRef.current = null;
        }
        if (seq !== seqRef.current) return;
        if (source !== "parent" && owned) setError(String(e));
      });
  }, [title]);

  useEffect(() => {
    setPayload(null);
    const handle = acquireOutlineSession(title, null);
    sessionRef.current = handle;
    const removeLoader = handle.setAuthoritativeLoader(async () => {
      try {
        const page = await apiFetch<PagePayload>(
          `/api/page/${encodeTitle(title)}`,
        );
        return page.blocks;
      } catch (e: unknown) {
        if (missingDaily(e, title)) return [];
        throw e;
      }
    });
    const removeParentController = handle.setParentReadController(
      () => load("parent", handle),
    );
    load("parent", handle);
    return () => {
      seqRef.current += 1;
      const read = readRef.current;
      if (read?.handle === handle) {
        read.readiness?.release();
        removeParentController();
        handle.cancelAuthoritativeRead(read.token);
        readRef.current = null;
      } else removeParentController();
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
        <PageTitle title={payload.page.title} />
        <EditablePage key={payload.page.title} title={payload.page.title}
                      initial={payload.blocks} composer />
      </article>
      <BacklinksSection key={`bl-${title}`} title={title} initial={payload.backlinks} />
      <UnlinkedSection key={`ul-${title}`} title={title} />
    </BlockRefProvider>
  );
}
