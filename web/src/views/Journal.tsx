// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { CanonicalTitle } from "../api/brands";
import { apiGet, apiPost } from "../api/typedClient";
import type { BlockRefText, JournalDay, PagePayload } from "../api/payloads";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { JournalDayReferences } from "../components/JournalDayReferences";
import { loadOutlineBlocks } from "../outline/loadOutlineBlocks";
import { substituteMissingDay } from "../outline/missingPage";
import { acquireOutlineSession,
         captureActiveOutlineReads,
         isOutlineSessionActive,
         type CapturedOutlineRead,
         type OutlineSessionHandle } from "../outline/outlineSessions";
import { pagePath } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";
import { useReducerRef } from "../useReducerRef";
import { initialJournalPaging, journalPager, journalPaging, loadInFlight,
         type JournalLoad,
         type JournalPaging,
         type JournalPagingEvent } from "./journalPaging";

// A day's authoritative page fetch 404s when it's been deleted (or never
// created) underneath us — an empty-daily prune, or the server's
// today-only auto-create declining a non-today title. Either
// way that's an empty day, not a failed load (substituteMissingDay).
const fetchDayBlocks = (title: CanonicalTitle): Promise<PagePayload["blocks"]> =>
  loadOutlineBlocks(title, substituteMissingDay);

export function Journal() {
  // The IntersectionObserver callback and the fetches read current(), never
  // a stale render's state.
  const { state: paging, current, dispatch } = useReducerRef<
    JournalPaging<JournalDay>, JournalPagingEvent<JournalDay>
  >(journalPaging, initialJournalPaging);
  const [refTexts, setRefTexts] = useState<Record<string, BlockRefText>>({});
  const [refCounts, setRefCounts] = useState<Record<string, number>>({});
  const mountedRef = useRef(false);
  const activeReadsRef = useRef(
    new Set<Map<string, CapturedOutlineRead>>(),
  );
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef(new Map<string, OutlineSessionHandle>());
  const sessionLoaderCleanupRef = useRef(new Map<string, () => void>());

  const sessionFor = useCallback((title: CanonicalTitle) => {
    let session = sessionsRef.current.get(title);
    if (!session) {
      session = acquireOutlineSession(title, null);
      sessionsRef.current.set(title, session);
      sessionLoaderCleanupRef.current.set(title,
        session.setAuthoritativeLoader("day", () => fetchDayBlocks(title)));
    }
    return session;
  }, []);

  const releaseReads = useCallback((
    reads: Map<string, CapturedOutlineRead>,
  ) => {
    if (!activeReadsRef.current.delete(reads)) return;
    for (const read of reads.values()) read.release();
  }, []);

  const releaseAllReads = useCallback(() => {
    for (const reads of [...activeReadsRef.current]) releaseReads(reads);
  }, [releaseReads]);

  const fetchLoad = useCallback(async (load: JournalLoad) => {
    const reads = captureActiveOutlineReads();
    activeReadsRef.current.add(reads);
    const live = () =>
      mountedRef.current && loadInFlight(current(), load.id) !== null;
    try {
      const p = await apiGet("/api/journal", {
        query: { days: load.want, before: load.before },
      });
      if (!live()) return;
      const received = p.days.map((day) => {
        const activeAtResponse = isOutlineSessionActive(day.title);
        const session = sessionFor(day.title);
        const captured = reads.get(day.title);
        if (captured) {
          captured.receive(day.blocks);
        } else if (activeAtResponse) {
          void session.requestAuthoritative(() => fetchDayBlocks(day.title))
            .catch(() => undefined);
        } else {
          const token = session.beginAuthoritativeRead();
          session.receiveAuthoritative(token, day.blocks);
        }
        return { ...day, blocks: session.getSnapshot().blocks };
      });
      // A head load replaces the ref-text map so stale resolutions can't
      // linger; older batches merge.
      const head = load.kind === "head";
      setRefTexts((m) => head ? { ...p.block_ref_texts }
                              : { ...m, ...p.block_ref_texts });
      setRefCounts((m) => head ? { ...p.block_ref_counts }
                               : { ...m, ...p.block_ref_counts });
      dispatch({ type: "loaded", id: load.id, days: received });
    } catch (e: unknown) {
      if (!live()) return;
      dispatch({ type: "failed", id: load.id, message: String(e) });
    } finally {
      releaseReads(reads);
    }
  }, [current, dispatch, releaseReads, sessionFor]);

  const run = useCallback((event: JournalPagingEvent<JournalDay>) => {
    if (!mountedRef.current) return;
    const before = current().loading;
    const { loading } = dispatch(event);
    if (loading !== null && loading !== before) void fetchLoad(loading);
  }, [current, dispatch, fetchLoad]);

  const loadOlder = useCallback(() => run({ type: "older" }), [run]);

  useEffect(() => {
    mountedRef.current = true;
    // Capture the mount-stable Map instances (useRef(new Map()), never
    // reassigned) so the cleanup operates on the same maps the effect saw,
    // as the lint's ref-in-cleanup guard requires.
    const loaderCleanups = sessionLoaderCleanupRef.current;
    const sessions = sessionsRef.current;
    return () => {
      mountedRef.current = false;
      dispatch({ type: "abandon" });
      releaseAllReads();
      for (const cleanup of loaderCleanups.values()) cleanup();
      loaderCleanups.clear();
      for (const session of sessions.values()) session.release();
      sessions.clear();
    };
  }, [dispatch, releaseAllReads]);
  useEffect(() => { loadOlder(); }, [loadOlder]);

  // Fire-and-forget: prune empty daily pages from the past week.
  // Failures are silent; the next Journal load retries. This effect runs
  // after the loadOlder effect above, so the journal GET is dispatched
  // first — but the two requests still race on the server over separate
  // connections, which is why deletions may not be reflected in this view
  // (see empty-daily-cleanup-design.md, Concurrency and staleness).
  useEffect(() => {
    void apiPost("/api/journal/cleanup")
      .catch(() => {});
  }, []);

  // A resync reloads the days on screen and supersedes any load in flight.
  // The day list is never blanked first: that would unmount every
  // .journal-day and remount it after the refetch, detaching the DOM
  // mid-interaction. Block content flows through the shared outline sessions,
  // and the reload replaces the day list in place under stable per-date keys.
  const reset = useCallback(() => {
    releaseAllReads();
    run({ type: "resync" });
  }, [releaseAllReads, run]);
  useResync(reset);

  const pager = journalPager(paging);
  const autoLoad = pager === "sentinel";
  useEffect(() => {
    if (!autoLoad) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadOlder();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoLoad, loadOlder]);

  return (
    <div className="journal">
      <BlockRefProvider seed={refTexts}>
        {/* the first loaded day is today by construction */}
        {paging.days.map((day, i) => ({ day, i }))
          .filter(({ day, i }) => day.exists || i === 0)
          .map(({ day }) => (
            <section className="journal-day" key={day.date}>
              <h1 className="page-title">
                <Link to={pagePath(day.title)}>{day.title}</Link>
              </h1>
              <EditablePage title={day.title} initial={day.blocks}
                            refCounts={refCounts} />
              <JournalDayReferences title={day.title}
                                   backlinks={day.backlinks} />
            </section>
          ))}
      </BlockRefProvider>
      {paging.error && <p className="error">{paging.error}</p>}
      <p className="journal-status" role="status" aria-live="polite">
        {paging.loading ? "Loading more days…" : ""}
      </p>
      {pager === "sentinel" && <div ref={sentinelRef} className="journal-sentinel" />}
      {pager === "button" && (
        <button className="show-more btn-secondary" onClick={loadOlder}>
          Load older days
        </button>
      )}
    </div>
  );
}
