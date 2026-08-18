// pattern: Imperative Shell
// The one outline page-loading controller (pkm-63s1). Every surface that
// shows an editable page outline — the main pane's PageView, a sidebar
// panel — loads through this hook, and differs from the others only in how
// it presents the result and where it scrolls.
//
// States: loading (no payload, no error) -> loaded | failed. Both state
// writes are keyed by the title they were requested for, so a response for
// the previous title can never render under the new one, and a title change
// resets to loading rather than re-showing a payload from an earlier mount.
//
// Per mounted title the hook holds one refcounted outline session and
// registers two things on it: an authoritative loader (blocks only, for
// reads the session starts itself) and a parent read controller (the
// session calls it to elect a fresh full-payload read when the current
// parent read dies or its owner unmounts).
//
// Events that start a read: mount and title change ("parent"); the session
// electing this surface as the recovery controller ("parent"); reload(source)
// — PageView's resync bump.
//
// Generation and cancellation rules, which the orderings below implement:
//  * every read takes the next generation, and starting one first releases
//    the previous read's parent readiness and cancels its token, so at most
//    one read per mount is outstanding;
//  * a response whose generation has been superseded releases readiness and
//    cancels its token instead of writing state. The session would reject
//    that token anyway, so this is not what stops a stale publish; it is how
//    the superseded read's reservation is freed when another surface's read
//    won, and it keeps one exit path for every settled response;
//  * the session, not the caller, decides adoption: state is written only
//    for a payload receiveParentAuthoritative() accepted, and a "parent"
//    read publishes through the readiness promise (which resolves with
//    whichever same-title read actually won) rather than from its own
//    response;
//  * cleanup bumps the generation, releases readiness, removes the parent
//    controller, cancels the outstanding token, removes the loader and
//    releases the session — in that order, so cancellation can never elect
//    a controller belonging to the unmounting surface.
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet } from "../api/typedClient";
import type { PagePayload } from "../api/payloads";
import { loadOutlineBlocks, statusOf } from "./loadOutlineBlocks";
import type { MissingPagePolicy } from "./missingPage";
import {
  acquireOutlineSession,
  type AuthoritativeReadSource,
  type OutlineSessionHandle,
  type ParentReadiness,
  type ReadToken,
} from "./outlineSessions";

interface OutlineRead {
  handle: OutlineSessionHandle;
  token: ReadToken;
  readiness: ParentReadiness | null;
}

export interface OutlinePageLoad {
  /** The page as loaded for the requested title, or null while loading. */
  payload: PagePayload | null;
  /** The failure message for the requested title; each surface renders it. */
  error: string | null;
  /** Start a fresh guarded read, e.g. after a resync bump. */
  reload: (source: AuthoritativeReadSource) => void;
}

export function useOutlinePageLoad(
  title: string,
  missingPage: MissingPagePolicy,
): OutlinePageLoad {
  const [payloadState, setPayloadState] = useState<{
    title: string;
    payload: PagePayload;
  } | null>(null);
  const [errorState, setErrorState] = useState<{
    title: string;
    message: string;
  } | null>(null);
  const seqRef = useRef(0);
  const sessionRef = useRef<OutlineSessionHandle | null>(null);
  const readRef = useRef<OutlineRead | null>(null);
  const missingPageRef = useRef(missingPage);
  missingPageRef.current = missingPage;

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
    const read: OutlineRead = { handle, token, readiness };
    readRef.current = read;
    setErrorState(null);
    if (readiness) {
      void readiness.promise
        .then((winner) => {
          if (seq !== seqRef.current) return;
          if (readRef.current === read) readRef.current = null;
          setErrorState(null);
          setPayloadState({
            title,
            payload: { ...winner, blocks: handle.getSnapshot().blocks },
          });
        })
        .catch((winnerError: unknown) => {
          if (seq !== seqRef.current) return;
          if (readRef.current === read) readRef.current = null;
          setErrorState({ title, message: String(winnerError) });
        });
    }
    // A substituted missing page is delivered here too: one delivery path,
    // whatever the response came from.
    const deliver = (page: PagePayload) => {
      if (seq !== seqRef.current) {
        readiness?.release();
        handle.cancelAuthoritativeRead(token);
        return;
      }
      const accepted = handle.receiveParentAuthoritative(token, page);
      if (readRef.current === read && (accepted || source !== "parent")) {
        readRef.current = null;
      }
      if (accepted && source !== "parent") {
        setPayloadState({
          title,
          payload: { ...page, blocks: handle.getSnapshot().blocks },
        });
      }
    };
    apiGet("/api/page/{title}", { path: { title } })
      .then(deliver)
      .catch((e: unknown) => {
        const substitute = missingPageRef.current(title, statusOf(e));
        if (substitute) {
          deliver(substitute);
          return;
        }
        const owned = handle.failAuthoritativeRead(token, e);
        if (readRef.current === read && source !== "parent") {
          readRef.current = null;
        }
        if (seq !== seqRef.current) return;
        if (source !== "parent" && owned) {
          setErrorState({ title, message: String(e) });
        }
      });
  }, [title]);

  useEffect(() => {
    setPayloadState(null);
    setErrorState(null);
    const handle = acquireOutlineSession(title, null);
    sessionRef.current = handle;
    // The "page" kind outranks every other loader for this title (see
    // outlineSessions' LOADER_PRECEDENCE): this surface owns the full-payload
    // parent read, so session-started reads should use the same fetch and the
    // same injected missing-page policy the view was constructed with.
    const removeLoader = handle.setAuthoritativeLoader(
      "page",
      () => loadOutlineBlocks(title, (t, s) => missingPageRef.current(t, s)),
    );
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

  const reload = useCallback(
    (source: AuthoritativeReadSource) => load(source), [load],
  );
  return {
    payload: payloadState?.title === title ? payloadState.payload : null,
    error: errorState?.title === title ? errorState.message : null,
    reload,
  };
}
