// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { BlockRefText, JournalDay, JournalPayload,
                  PagePayload } from "../api/payloads";
import { BlockRefProvider } from "../components/BlockRefProvider";
import { acquireOutlineSession,
         captureActiveOutlineReads,
         isOutlineSessionActive,
         type AuthoritativeReadSource,
         type OutlineSessionHandle } from "../outline/outlineSessions";
import { encodeTitle, pagePath } from "../paths";
import { useResync } from "../sync/SyncProvider";
import { EditablePage } from "./EditablePage";

const BATCH = 5;
const MAX_EMPTY_BATCHES = 3;

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
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const sessionsRef = useRef(new Map<string, OutlineSessionHandle>());
  const sessionLoaderCleanupRef = useRef(new Map<string, () => void>());

  const sessionFor = useCallback((title: string) => {
    let session = sessionsRef.current.get(title);
    if (!session) {
      session = acquireOutlineSession(title, null);
      sessionsRef.current.set(title, session);
      sessionLoaderCleanupRef.current.set(title,
        session.setAuthoritativeLoader(async () => {
          const page = await apiFetch<PagePayload>(
            `/api/page/${encodeTitle(title)}`,
          );
          return page.blocks;
        }));
    }
    return session;
  }, []);

  const loadMore = useCallback(async (
    source: AuthoritativeReadSource = "parent",
  ) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    const gen = genRef.current;
    const reads = captureActiveOutlineReads(source);
    try {
      const current = daysRef.current;
      const oldest = current[current.length - 1]?.date;
      // `before` is exclusive of the date given: passing the oldest loaded
      // date returns the day before it first (days come back newest-first).
      const qs = oldest ? `?days=${BATCH}&before=${oldest}` : `?days=${BATCH}`;
      const p = await apiFetch<JournalPayload>(`/api/journal${qs}`);
      if (gen !== genRef.current) return; // reset() superseded this load: discard
      const received = p.days.map((day) => {
        const activeAtResponse = isOutlineSessionActive(day.title);
        const session = sessionFor(day.title);
        const captured = reads.get(day.title);
        if (captured) {
          captured.receive(day.blocks);
        } else if (activeAtResponse) {
          void session.requestAuthoritative(async () => {
            const page = await apiFetch<PagePayload>(
              `/api/page/${encodeTitle(day.title)}`,
            );
            return page.blocks;
          }).catch(() => undefined);
        } else {
          const token = session.beginAuthoritativeRead(source);
          session.receiveAuthoritative(token, day.blocks);
        }
        return { ...day, blocks: session.getSnapshot().blocks };
      });
      const next = [...current, ...received];
      daysRef.current = next;
      setDays(next);
      setRefTexts((m) => ({ ...m, ...p.block_ref_texts }));
      emptyStreakRef.current =
        p.days.some((d) => d.exists) ? 0 : emptyStreakRef.current + 1;
      if (emptyStreakRef.current >= MAX_EMPTY_BATCHES) setAutoLoad(false);
    } catch (e: unknown) {
      if (gen !== genRef.current) return; // reset() superseded this load: discard
      setError(String(e));
      setAutoLoad(false);
    } finally {
      for (const read of reads.values()) read.release();
      // A superseded load must not release the lock: it now belongs to the
      // reset()-triggered reload that took over this generation.
      if (gen === genRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [sessionFor]);

  useEffect(() => { void loadMore(); }, [loadMore]);
  useEffect(() => () => {
    for (const cleanup of sessionLoaderCleanupRef.current.values()) cleanup();
    sessionLoaderCleanupRef.current.clear();
    for (const session of sessionsRef.current.values()) session.release();
    sessionsRef.current.clear();
  }, []);
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
    loadingRef.current = false;
    daysRef.current = [];
    setDays([]);
    setRefTexts({});
    emptyStreakRef.current = 0;
    setAutoLoad(true);
    void loadMore("resync");
  }, [loadMore]);
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
