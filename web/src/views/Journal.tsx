// pattern: Imperative Shell
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../api/client";
import type { JournalDay, JournalPayload } from "../api/payloads";
import { BlockTree } from "../components/BlockTree";
import { pagePath } from "../paths";

const BATCH = 5;
const MAX_EMPTY_BATCHES = 3;

export function Journal() {
  const [days, setDays] = useState<JournalDay[]>([]);
  const [autoLoad, setAutoLoad] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Refs, not state, so the IntersectionObserver callback never goes stale.
  const daysRef = useRef<JournalDay[]>([]);
  const emptyStreakRef = useRef(0);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const loadMore = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const current = daysRef.current;
      const oldest = current[current.length - 1]?.date;
      // `before` is exclusive of the date given: passing the oldest loaded
      // date returns the day before it first (days come back newest-first).
      const qs = oldest ? `?days=${BATCH}&before=${oldest}` : `?days=${BATCH}`;
      const p = await apiFetch<JournalPayload>(`/api/journal${qs}`);
      const next = [...current, ...p.days];
      daysRef.current = next;
      setDays(next);
      emptyStreakRef.current =
        p.days.some((d) => d.exists) ? 0 : emptyStreakRef.current + 1;
      if (emptyStreakRef.current >= MAX_EMPTY_BATCHES) setAutoLoad(false);
    } catch (e: unknown) {
      setError(String(e));
      setAutoLoad(false);
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadMore(); }, [loadMore]);
  useEffect(() => { document.title = "Daily Notes — pkm"; }, []);

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
      {days.map((day) => (
        <section className="journal-day" key={day.date}>
          <h1 className="page-title">
            <Link to={pagePath(day.title)}>{day.title}</Link>
          </h1>
          {day.exists && day.blocks.length > 0
            ? <BlockTree blocks={day.blocks} />
            : <p className="empty-day">No notes</p>}
        </section>
      ))}
      {error && <p className="error">{error}</p>}
      <p className="journal-status" role="status" aria-live="polite">
        {loading ? "Loading more days…" : ""}
      </p>
      {autoLoad
        ? <div ref={sentinelRef} className="journal-sentinel" />
        : (
          <button className="show-more"
                  onClick={() => { setAutoLoad(true); void loadMore(); }}>
            Load older days
          </button>
        )}
    </div>
  );
}
