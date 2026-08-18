// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiGet } from "../api/typedClient";
import type { Backlinks } from "../api/payloads";
import { BlockRefContext } from "../contexts";

import type { BacklinkBatchState } from "./backlinkBatchWalk";
import { mergeBacklinkResult, walkBacklinkBatches } from "./backlinkBatchWalk";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, toggleChip,
         type FilterState } from "./backlinkFilter";
import { BacklinkGroupList } from "./BacklinkGroupList";

export function BacklinksSection({ title, initial, refreshGeneration = 0 }:
    { title: string; initial: Backlinks; refreshGeneration?: number }) {
  const base = useContext(BlockRefContext);
  // groups, total page count, and extra ref texts change in lockstep -- one
  // state value so a partial update can't happen. total_pages can shrink or
  // grow server-side (multi-tab sync) between mount and panel open; it's
  // tracked here (not frozen from the initial prop) so completion is
  // derived from the latest known value.
  const [backlinks, setBacklinks] = useState<BacklinkBatchState>({
    groups: initial.groups, totalPages: initial.total_pages, refTexts: {},
  });
  // Shared by loadMore and loadAll, not per-caller: if both are ever in
  // flight together the first to settle re-enables both buttons early. Both
  // walks are idempotent, so a stray extra click just repeats a batch fetch
  // — cosmetic, not a correctness bug.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const refreshEpoch = useRef(0);
  const refreshInFlight = useRef(false);
  const seenRefreshGeneration = useRef(refreshGeneration);
  const hasMore = backlinks.groups.length < backlinks.totalPages;
  const fullyLoaded = !hasMore;

  const fetchBatch = useCallback((offset: number, limit: number) =>
    apiGet("/api/page/{title}", {
      path: { title },
      query: { bl_offset: offset, bl_limit: limit },
    }), [title]);

  const loadMore = async () => {
    if (refreshInFlight.current) return;
    const epoch = refreshEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const result = await walkBacklinkBatches(
        fetchBatch, backlinks,
        (_state, batchesFetched) => (batchesFetched === 0 ? initial.limit : null),
        () => epoch !== refreshEpoch.current);
      if (result === "stale" || epoch !== refreshEpoch.current) return;
      // Merge onto the latest state, not the stale snapshot the walk
      // started from: loadMore and loadAll guard only against a concurrent
      // refresh, not against each other, so both can be in flight at once.
      setBacklinks((current) => mergeBacklinkResult(current, result));
    } catch (loadFailure: unknown) {
      if (epoch === refreshEpoch.current) setError(String(loadFailure));
    } finally {
      setLoading(false);
    }
  };

  // The filter panel needs every backlink loaded: chips and counts must
  // not lie about pages that simply weren't fetched yet.
  const loadAll = async () => {
    if (refreshInFlight.current) return;
    const epoch = refreshEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const result = await walkBacklinkBatches(
        fetchBatch, backlinks,
        (state) => (state.groups.length < state.totalPages ? 100 : null),
        () => epoch !== refreshEpoch.current);
      if (result === "stale" || epoch !== refreshEpoch.current) return;
      setBacklinks((current) => mergeBacklinkResult(current, result));
    } catch (loadFailure: unknown) {
      if (epoch === refreshEpoch.current) setError(String(loadFailure));
    } finally {
      setLoading(false);
    }
  };

  const refresh = useCallback(async () => {
    const epoch = ++refreshEpoch.current;
    refreshInFlight.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      // Replace everything from scratch: the first batch's size depends on
      // whether the filter panel needs every page loaded, then (only while
      // the panel stays open) the walk continues in full-size batches.
      // totalPages: Infinity is safe here only because nextLimit's
      // batchesFetched === 0 branch below returns unconditionally, never
      // reading state.totalPages first — a check that ran before the first
      // batch landed would never see anything but Infinity and loop forever.
      const result = await walkBacklinkBatches(
        fetchBatch, { groups: [], totalPages: Infinity, refTexts: {} },
        (state, batchesFetched) => (batchesFetched === 0
          ? (panelOpen ? 100 : initial.limit)
          : (panelOpen && state.groups.length < state.totalPages ? 100 : null)),
        () => epoch !== refreshEpoch.current);
      if (result === "stale" || epoch !== refreshEpoch.current) return;
      setBacklinks(result);
    } catch (refreshFailure: unknown) {
      if (epoch === refreshEpoch.current) setRefreshError(String(refreshFailure));
    } finally {
      if (epoch === refreshEpoch.current) {
        refreshInFlight.current = false;
        setRefreshing(false);
      }
    }
  }, [fetchBatch, initial.limit, panelOpen]);

  useEffect(() => {
    if (refreshGeneration === seenRefreshGeneration.current) return;
    seenRefreshGeneration.current = refreshGeneration;
    void refresh();
  }, [refreshGeneration, refresh]);

  const openPanel = () => {
    if (refreshInFlight.current) return;
    setPanelOpen(true);
    if (hasMore) void loadAll();
  };

  const filtering = isFiltering(filter);
  const visible = useMemo(() => applyFilter(backlinks.groups, filter),
    [backlinks.groups, filter]);
  const chips = useMemo(
    () => panelOpen && fullyLoaded
      ? chipCounts(visible, [title, ...filter.include, ...filter.exclude])
      : [],
    [panelOpen, fullyLoaded, visible, title, filter]);

  const chipButton = (t: string, side: "include" | "exclude", label: string) => (
    <button key={`${side}:${t}`} className={`filter-chip ${side}d`}
            onClick={() => setFilter((f) => toggleChip(f, t, side))}>
      {label}
    </button>
  );

  return (
    <BlockRefContext.Provider value={{ ...base, ...backlinks.refTexts }}>
      <section className="backlinks">
        <h2 className="section-header">
          Linked references ({filtering
            ? `${visible.length} of ${backlinks.totalPages}` : backlinks.totalPages})
          {backlinks.totalPages > 0 && (
            <button className="filter-toggle btn-secondary" aria-expanded={panelOpen}
                    onClick={() => (panelOpen ? setPanelOpen(false) : openPanel())}
                    disabled={refreshing && !panelOpen}>
              Filter{filtering
                ? ` (${filter.include.length + filter.exclude.length})` : ""}
            </button>
          )}
        </h2>
        {panelOpen && (
          <div className="filter-panel">
            {filtering && (
              <div className="filter-active">
                {filter.include.map((t) => chipButton(t, "include", t))}
                {filter.exclude.map((t) => chipButton(t, "exclude", t))}
                <button className="filter-clear"
                        onClick={() => setFilter(EMPTY_FILTER)}>Clear</button>
              </div>
            )}
            {!fullyLoaded && !error &&
              <p className="filter-loading">Loading all references…</p>}
            {fullyLoaded && (
              <div className="filter-candidates">
                {chips.map((c) => (
                  <button key={c.title} className="filter-chip"
                          title="Click to include, shift-click to exclude"
                          onClick={(e) => setFilter((f) =>
                            toggleChip(f, c.title, e.shiftKey ? "exclude" : "include"))}>
                    {c.title} ({c.count})
                  </button>
                ))}
                {chips.length === 0 && !filtering &&
                  <p className="filter-empty">No references to filter on</p>}
              </div>
            )}
          </div>
        )}
        <BacklinkGroupList groups={visible} />
        {filtering && fullyLoaded && visible.length === 0 && (
          <p className="filter-no-match">No matching references</p>
        )}
        {refreshError && <p className="error">{refreshError}</p>}
        {refreshError && (
          <button className="show-more btn-secondary"
                  onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Retry refresh"}
          </button>
        )}
        {error && <p className="error">{error}</p>}
        {error && panelOpen && !fullyLoaded && (
          <button className="show-more btn-secondary" onClick={() => void loadAll()}
                  disabled={loading || refreshing}>
            {loading ? "Loading…" : "Retry"}
          </button>
        )}
        {hasMore && !panelOpen && (
          <button className="show-more btn-secondary" onClick={() => void loadMore()}
                  disabled={loading || refreshing}>
            {loading ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </BlockRefContext.Provider>
  );
}
