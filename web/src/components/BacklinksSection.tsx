// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalTitle } from "../api/brands";
import { apiGet } from "../api/typedClient";
import type { Backlinks } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { useTitleReader } from "../sync/titleCanonicalization";
import { useReducerRef } from "../useReducerRef";

import { walkBacklinkBatches, type NextBatchLimit } from "./backlinkBatchWalk";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, toggleChip,
         type FilterState } from "./backlinkFilter";
import { BacklinkGroupList } from "./BacklinkGroupList";
import { backlinksPaging, hasMore as hasMoreOf, initialBacklinksPaging,
         walking } from "./backlinksPaging";

export function BacklinksSection({ title, initial, refreshGeneration = 0 }:
    { title: CanonicalTitle; initial: Backlinks; refreshGeneration?: number }) {
  const base = useContext(BlockRefContext);
  const read = useTitleReader();
  // total_pages can shrink or grow server-side (multi-tab sync) between
  // mount and panel open; it's tracked in `shown` (not frozen from the
  // initial prop) so completion is derived from the latest known value.
  const { state: paging, current, dispatch } = useReducerRef(
    backlinksPaging, () => initialBacklinksPaging(initial));
  const { shown: backlinks, refreshing, refreshError, panelOpen } = paging;
  const error = paging.walkError;
  const loading = walking(paging);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const seenRefreshGeneration = useRef(refreshGeneration);
  const hasMore = hasMoreOf(paging);
  const fullyLoaded = !hasMore;

  const fetchBatch = useCallback((offset: number, limit: number) =>
    apiGet("/api/page/{title}", {
      path: { title },
      query: { bl_offset: offset, bl_limit: limit },
    }), [title]);

  // A walk reads current(), not the render's state: a click in the same
  // tick as a refresh starting must be refused.
  const walk = async (nextLimit: NextBatchLimit) => {
    const before = current();
    const started = dispatch({ type: "walkStarted" });
    if (started === before) return;
    const { epoch, shown } = started;
    const id = started.nextWalk - 1;
    try {
      const result = await walkBacklinkBatches(
        fetchBatch, shown, nextLimit, () => current().epoch !== epoch);
      dispatch(result === "stale"
        ? { type: "walkDropped", id }
        : { type: "walkLoaded", id, epoch, result });
    } catch (loadFailure: unknown) {
      dispatch({ type: "walkFailed", id, epoch,
                 message: String(loadFailure) });
    }
  };

  const loadMore = () => walk(
    (_state, batchesFetched) => (batchesFetched === 0 ? initial.limit : null));

  // The filter panel needs every backlink loaded: chips and counts must
  // not lie about pages that simply weren't fetched yet.
  const loadAll = () => walk(
    (state) => (state.groups.length < state.totalPages ? 100 : null));

  const refresh = useCallback(async () => {
    const { epoch, panelOpen: open } = dispatch({ type: "refreshStarted" });
    try {
      // Replace everything from scratch: the first batch's size depends on
      // whether the filter panel needs every page loaded, then (only if the
      // panel was open when the refresh started) the walk continues in
      // full-size batches.
      // totalPages: Infinity is safe here only because nextLimit's
      // batchesFetched === 0 branch below returns unconditionally, never
      // reading state.totalPages first — a check that ran before the first
      // batch landed would never see anything but Infinity and loop forever.
      const result = await walkBacklinkBatches(
        fetchBatch, { groups: [], totalPages: Infinity, refTexts: {} },
        (state, batchesFetched) => (batchesFetched === 0
          ? (open ? 100 : initial.limit)
          : (open && state.groups.length < state.totalPages ? 100 : null)),
        () => current().epoch !== epoch);
      if (result === "stale") return;
      dispatch({ type: "refreshLoaded", epoch, result });
    } catch (refreshFailure: unknown) {
      dispatch({ type: "refreshFailed", epoch,
                 message: String(refreshFailure) });
    }
  }, [current, dispatch, fetchBatch, initial.limit]);

  useEffect(() => {
    if (refreshGeneration === seenRefreshGeneration.current) return;
    seenRefreshGeneration.current = refreshGeneration;
    void refresh();
  }, [refreshGeneration, refresh]);

  const openPanel = () => {
    const before = current();
    const opened = dispatch({ type: "panelOpened" });
    if (opened !== before && hasMoreOf(opened)) void loadAll();
  };

  const filtering = isFiltering(filter);
  const visible = useMemo(() => applyFilter(backlinks.groups, filter, read),
    [backlinks.groups, filter, read]);
  const chips = useMemo(
    () => panelOpen && fullyLoaded
      ? chipCounts(visible, [title, ...filter.include, ...filter.exclude], read)
      : [],
    [panelOpen, fullyLoaded, visible, title, filter, read]);

  const chipButton = (t: CanonicalTitle, side: "include" | "exclude", label: string) => (
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
                    onClick={() => (panelOpen
                      ? dispatch({ type: "panelClosed" }) : openPanel())}
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
