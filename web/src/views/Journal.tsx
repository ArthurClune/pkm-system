// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, apiFetch } from "../api/client";
import type { BlockRefText, JournalDay, JournalPayload,
                  PagePayload } from "../api/payloads";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { acquireOutlineSession,
         captureActiveOutlineReads,
         isOutlineSessionActive,
         type AuthoritativeReadSource,
         type CapturedOutlineRead,
         type OutlineSessionHandle } from "../outline/outlineSessions";
import { encodeTitle, pagePath } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

const BATCH = 5;
const MAX_EMPTY_BATCHES = 3;

// A day's authoritative page fetch 404s when it's been deleted (or never
// created) underneath us — an empty-daily prune, or the server's
// today-only auto-create (pkm-fy52) declining a non-today title. Either
// way that's an empty day, not a failed load.
async function fetchDayBlocks(title: string): Promise<PagePayload["blocks"]> {
  try {
    const page = await apiFetch<PagePayload>(`/api/page/${encodeTitle(title)}`);
    return page.blocks;
  } catch (e: unknown) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw e;
  }
}

export function Journal() {
  const [days, setDays] = useState<JournalDay[]>([]);
  const [refTexts, setRefTexts] = useState<Record<string, BlockRefText>>({});
  const [autoLoad, setAutoLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Refs, not state, so the IntersectionObserver callback never goes stale.
  const daysRef = useRef<JournalDay[]>([]);
  const emptyStreakRef = useRef(0);
  const loadingRef = useRef(false);
  const genRef = useRef(0);
  const mountedRef = useRef(false);
  const activeReadsRef = useRef(
    new Set<Map<string, CapturedOutlineRead>>(),
  );
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef(new Map<string, OutlineSessionHandle>());
  const sessionLoaderCleanupRef = useRef(new Map<string, () => void>());

  const sessionFor = useCallback((title: string) => {
    let session = sessionsRef.current.get(title);
    if (!session) {
      session = acquireOutlineSession(title, null);
      sessionsRef.current.set(title, session);
      sessionLoaderCleanupRef.current.set(title,
        session.setAuthoritativeLoader(() => fetchDayBlocks(title)));
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

  const loadMore = useCallback(async (
    source: AuthoritativeReadSource = "parent",
  ) => {
    if (!mountedRef.current || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const gen = genRef.current;
    const reads = captureActiveOutlineReads(source);
    activeReadsRef.current.add(reads);
    try {
      const current = daysRef.current;
      const oldest = current[current.length - 1]?.date;
      // `before` is exclusive of the date given: passing the oldest loaded
      // date returns the day before it first (days come back newest-first).
      const qs = oldest ? `?days=${BATCH}&before=${oldest}` : `?days=${BATCH}`;
      const p = await apiFetch<JournalPayload>(`/api/journal${qs}`);
      if (!mountedRef.current || gen !== genRef.current) return;
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
          const token = session.beginAuthoritativeRead(source);
          session.receiveAuthoritative(token, day.blocks);
        }
        return { ...day, blocks: session.getSnapshot().blocks };
      });
      const next = [...current, ...received];
      daysRef.current = next;
      setDays(next);
      // A head load (no `before` cursor: first mount or resync) replaces the
      // ref-text map so stale resolutions can't linger; older batches merge.
      setRefTexts((m) => oldest
        ? { ...m, ...p.block_ref_texts }
        : { ...p.block_ref_texts });
      emptyStreakRef.current =
        p.days.some((d) => d.exists) ? 0 : emptyStreakRef.current + 1;
      if (emptyStreakRef.current >= MAX_EMPTY_BATCHES) setAutoLoad(false);
    } catch (e: unknown) {
      if (!mountedRef.current || gen !== genRef.current) return;
      setError(String(e));
      setAutoLoad(false);
    } finally {
      releaseReads(reads);
      // A superseded load must not release the lock: it now belongs to the
      // reset()-triggered reload that took over this generation.
      if (mountedRef.current && gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [releaseReads, sessionFor]);

  useEffect(() => {
    mountedRef.current = true;
    // Capture the mount-stable Map instances (useRef(new Map()), never
    // reassigned) so the cleanup operates on the same maps the effect saw,
    // as the lint's ref-in-cleanup guard requires.
    const loaderCleanups = sessionLoaderCleanupRef.current;
    const sessions = sessionsRef.current;
    return () => {
      mountedRef.current = false;
      genRef.current += 1;
      loadingRef.current = false;
      releaseAllReads();
      for (const cleanup of loaderCleanups.values()) cleanup();
      loaderCleanups.clear();
      for (const session of sessions.values()) session.release();
      sessions.clear();
    };
  }, [releaseAllReads]);
  useEffect(() => { void loadMore(); }, [loadMore]);
  useEffect(() => { document.title = "Daily Notes — pkm"; }, []);

  // Fire-and-forget: prune empty daily pages from the past week (pkm-c3kz).
  // Failures are silent; the next Journal load retries. This effect runs
  // after the loadMore effect above, so the journal GET is dispatched
  // first — but the two requests still race on the server over separate
  // connections, which is why deletions may not be reflected in this view
  // (see spec's Concurrency and staleness section).
  useEffect(() => {
    void apiFetch("/api/journal/cleanup", { method: "POST" })
      .catch(() => {});
  }, []);

  const reset = useCallback(() => {
    // Invalidate any in-flight loadMore so its stale response can't clobber
    // the authoritative refetch, and release its lock so we can start now.
    genRef.current += 1;
    releaseAllReads();
    loadingRef.current = false;
    // Clear only the cursor (daysRef), not the rendered day list: blanking
    // setDays here unmounted every .journal-day and remounted it after the
    // refetch, detaching the DOM mid-interaction (pkm-ss9k remount churn).
    // Freshness doesn't need the remount — block content flows through the
    // shared outline sessions, and the head reload below replaces the day
    // list in place under stable per-date keys when it lands.
    daysRef.current = [];
    emptyStreakRef.current = 0;
    setAutoLoad(true);
    void loadMore("resync");
  }, [loadMore, releaseAllReads]);
  useResync(reset);

  useEffect(() => {
    if (!autoLoad) return;
    const el = sentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [autoLoad, loadMore]);

  return (
    <div className="journal">
      <BlockRefProvider seed={refTexts}>
        {days.map((day, i) => ({ day, i }))
          .filter(({ day, i }) => day.exists || i === 0)
          .map(({ day, i }) => (
            <section className="journal-day" key={day.date}>
              <h1 className="page-title">
                <Link to={pagePath(day.title)}>{day.title}</Link>
              </h1>
              {/* the first loaded day is today by construction */}
              <EditablePage title={day.title} initial={day.blocks}
                            composer={i === 0} />
            </section>
          ))}
      </BlockRefProvider>
      {error && <p className="error">{error}</p>}
      <p className="journal-status" role="status" aria-live="polite">
        {loading ? "Loading more days…" : ""}
      </p>
      {autoLoad
        ? <div ref={sentinelRef} className="journal-sentinel" />
        : (
          <button className="show-more btn-secondary"
                  onClick={() => { setAutoLoad(true); void loadMore(); }}>
            Load older days
          </button>
        )}
    </div>
  );
}
