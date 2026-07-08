// pattern: Imperative Shell
import { useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { BlockGroup, GroupsPayload } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";
import { mergeGroups } from "./groups";

const PAGE_SIZE = 20;

// A query whose results contain another {{query}} (e.g. a self-matching
// block) would otherwise re-mount an identical QueryBlock and recurse
// forever, fetch after fetch. Same guard idea as BlockRef's MAX_DEPTH.
const MAX_DEPTH = 2;

export function QueryBlock({ expr, depth = 0 }: { expr: string; depth?: number }) {
  const capped = depth >= MAX_DEPTH;
  const [groups, setGroups] = useState<BlockGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async (from: number) => {
    setLoading(true);
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/query?expr=${encodeURIComponent(expr)}&limit=${PAGE_SIZE}&offset=${from}`);
      setGroups((g) => (from === 0 ? p.groups : mergeGroups(g, p.groups)));
      setTotal(p.total);
      setOffset(from + p.groups.reduce((n, gr) => n + gr.items.length, 0));
      setError(null);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (capped) return;
    setGroups([]);
    setTotal(null);
    setOffset(0);
    setError(null);
    void load(0);
    // load(0) reads only `expr`/`capped` from scope; re-run on those alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr, capped]);

  if (capped) {
    // Inert placeholder matching the pre-live fallback: no fetch, no results.
    return <span className="query-pending">{`{{query: ${expr}}}`}</span>;
  }

  return (
    <div className="query-block">
      <div className="query-header">
        <span className="query-expr">query: {expr}</span>
        {total !== null && (
          <span className="query-total">
            {total} result{total === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {groups.map((g) => (
        <div className="query-group" key={g.page_id}>
          <div className="group-title"><PageLink title={g.page_title} tag={false} /></div>
          {g.items.map((item) => (
            <div className="query-item" key={item.uid}>
              <InlineSegments segments={tokenizeBlock(item.text)} depth={depth + 1} />
            </div>
          ))}
        </div>
      ))}
      {total !== null && offset < total && (
        <button className="show-more" onClick={() => void load(offset)} disabled={loading}>
          {loading ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
