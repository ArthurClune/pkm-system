// pattern: Imperative Shell
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { BacklinkGroup, Backlinks, BlockRefText, PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { encodeTitle } from "../paths";
import { applyFilter, chipCounts, EMPTY_FILTER, isFiltering, toggleChip,
         type FilterState } from "./backlinkFilter";
import { mergeGroups } from "./groups";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";

export function BacklinksSection({ title, initial, refreshGeneration = 0 }:
    { title: string; initial: Backlinks; refreshGeneration?: number }) {
  const base = useContext(BlockRefContext);
  const [groups, setGroups] = useState<BacklinkGroup[]>(initial.groups);
  const [extraRefTexts, setExtraRefTexts] =
    useState<Record<string, BlockRefText>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  // total_pages can shrink or grow server-side (multi-tab sync) between
  // mount and panel open; track it in state so completion is derived from
  // the latest known value, not whatever was frozen at mount.
  const [totalPages, setTotalPages] = useState(initial.total_pages);
  const refreshEpoch = useRef(0);
  const refreshInFlight = useRef(false);
  const seenRefreshGeneration = useRef(refreshGeneration);
  const hasMore = groups.length < totalPages;
  const fullyLoaded = !hasMore;

  const fetchBatch = useCallback((offset: number, limit: number) =>
    apiFetch<PagePayload>(
      `/api/page/${encodeTitle(title)}?bl_offset=${offset}&bl_limit=${limit}`,
    ), [title]);

  const loadMore = async () => {
    if (refreshInFlight.current) return;
    const epoch = refreshEpoch.current;
    setLoading(true);
    setError(null);
    try {
      const payload = await fetchBatch(groups.length, initial.limit);
      if (epoch !== refreshEpoch.current) return;
      setGroups((current) => mergeGroups(current, payload.backlinks.groups));
      setTotalPages(payload.backlinks.total_pages);
      setExtraRefTexts((current) => ({
        ...current,
        ...payload.block_ref_texts,
      }));
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
      let all = groups;
      let total = totalPages;
      let refTexts = { ...extraRefTexts };
      while (all.length < total) {
        const payload = await fetchBatch(all.length, 100);
        if (epoch !== refreshEpoch.current) return;
        total = payload.backlinks.total_pages;
        refTexts = { ...refTexts, ...payload.block_ref_texts };
        if (payload.backlinks.groups.length === 0) break;
        const before = all.length;
        all = mergeGroups(all, payload.backlinks.groups);
        if (all.length === before) break;
      }
      if (epoch !== refreshEpoch.current) return;
      setGroups(all);
      setTotalPages(total);
      setExtraRefTexts(refTexts);
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
      let payload = await fetchBatch(0, panelOpen ? 100 : initial.limit);
      if (epoch !== refreshEpoch.current) return;
      let nextGroups = payload.backlinks.groups;
      let nextTotal = payload.backlinks.total_pages;
      let nextRefTexts = { ...payload.block_ref_texts };
      while (panelOpen && nextGroups.length < nextTotal) {
        payload = await fetchBatch(nextGroups.length, 100);
        if (epoch !== refreshEpoch.current) return;
        nextTotal = payload.backlinks.total_pages;
        nextRefTexts = { ...nextRefTexts, ...payload.block_ref_texts };
        if (payload.backlinks.groups.length === 0) break;
        const before = nextGroups.length;
        nextGroups = mergeGroups(nextGroups, payload.backlinks.groups);
        if (nextGroups.length === before) break;
      }
      if (epoch !== refreshEpoch.current) return;
      setGroups(nextGroups);
      setTotalPages(nextTotal);
      setExtraRefTexts(nextRefTexts);
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
  const visible = useMemo(() => applyFilter(groups, filter), [groups, filter]);
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
    <BlockRefContext.Provider value={{ ...base, ...extraRefTexts }}>
      <section className="backlinks">
        <h2 className="section-header">
          Linked references ({filtering
            ? `${visible.length} of ${totalPages}` : totalPages})
          {totalPages > 0 && (
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
        {visible.map((g) => (
          <div className="backlink-group" key={g.page_id}>
            <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
            {g.items.map((item) => (
              <div className="backlink-item" key={item.uid}>
                {item.breadcrumbs.length > 0 && (
                  <div className="breadcrumbs">{item.breadcrumbs.join(" › ")}</div>
                )}
                <div className="backlink-text">
                  <InlineSegments segments={tokenizeBlock(item.text)} />
                </div>
              </div>
            ))}
          </div>
        ))}
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
