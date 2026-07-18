// pattern: Imperative Shell
import { useContext, useMemo, useState } from "react";
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

export function BacklinksSection({ title, initial }:
    { title: string; initial: Backlinks }) {
  const base = useContext(BlockRefContext);
  const [groups, setGroups] = useState<BacklinkGroup[]>(initial.groups);
  const [extraRefTexts, setExtraRefTexts] =
    useState<Record<string, BlockRefText>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  // total_pages can shrink or grow server-side (multi-tab sync) between
  // mount and panel open; track it in state so completion is derived from
  // the latest known value, not whatever was frozen at mount.
  const [totalPages, setTotalPages] = useState(initial.total_pages);
  const hasMore = groups.length < totalPages;
  const fullyLoaded = !hasMore;

  const fetchBatch = async (offset: number, limit: number) => {
    // bl pagination counts source pages; the accumulated length is the
    // next offset.
    const p = await apiFetch<PagePayload>(
      `/api/page/${encodeTitle(title)}?bl_offset=${offset}&bl_limit=${limit}`);
    setExtraRefTexts((m) => ({ ...m, ...p.block_ref_texts }));
    return p.backlinks;
  };

  const loadMore = async () => {
    setLoading(true);
    setError(null);
    try {
      const batch = await fetchBatch(groups.length, initial.limit);
      setGroups((g) => mergeGroups(g, batch.groups));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  // The filter panel needs every backlink loaded: chips and counts must
  // not lie about pages that simply weren't fetched yet.
  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      let all = groups;
      let total = totalPages;
      while (all.length < total) {
        const batch = await fetchBatch(all.length, 100);
        total = batch.total_pages; // trust the latest response, shrunk or grown
        if (batch.groups.length === 0) break; // total shrank server-side
        const before = all.length;
        all = mergeGroups(all, batch.groups);
        if (all.length === before) break; // no growth; avoid re-requesting forever
        setGroups(all);
      }
      setTotalPages(total);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const openPanel = () => {
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
                    onClick={() => (panelOpen ? setPanelOpen(false) : openPanel())}>
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
        {error && <p className="error">{error}</p>}
        {error && panelOpen && !fullyLoaded && (
          <button className="show-more btn-secondary" onClick={() => void loadAll()}
                  disabled={loading}>
            {loading ? "Loading…" : "Retry"}
          </button>
        )}
        {hasMore && !panelOpen && (
          <button className="show-more btn-secondary" onClick={() => void loadMore()}
                  disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </BlockRefContext.Provider>
  );
}
