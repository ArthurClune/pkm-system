// pattern: Imperative Shell
import { useEffect, useRef, useState } from "react";
import { OfflineError, apiFetch } from "../api/client";
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

  // Every fetch (the expr's own load and each page request) is stamped with
  // a monotonically increasing request id; a response is applied only if
  // it's still current when it resolves. This — not an AbortController — is
  // what actually drops stale results: the offline gateway (pkm-y8p0) can
  // still complete a request whose abort it never honored, so the id check
  // stays the single source of truth regardless of how a response arrives.
  // pageRequest additionally blocks a second page request from firing at
  // all while one is outstanding (e.g. a double-clicked "Show more"). It
  // holds the owning request's id, not a boolean, so only the request that
  // set it may clear it on settle — a stale generation's page request
  // settling late can't reopen the guard while the current generation's
  // page request is still in flight, and a page request issued from
  // offset 0 (empty first page with a nonzero total) still releases it.
  const requestIdRef = useRef(0);
  const pageRequestRef = useRef<number | null>(null);

  const load = async (from: number, requestId: number) => {
    setLoading(true);
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/query?expr=${encodeURIComponent(expr)}&limit=${PAGE_SIZE}&offset=${from}`);
      if (requestId !== requestIdRef.current) return; // superseded: drop silently
      setGroups((g) => (from === 0 ? p.groups : mergeGroups(g, p.groups)));
      setTotal(p.total);
      setOffset(from + p.groups.reduce((n, gr) => n + gr.items.length, 0));
      setError(null);
    } catch (e: unknown) {
      if (requestId !== requestIdRef.current) return;
      // query blocks are online-only in v1 (spec section 4)
      setError(e instanceof OfflineError ? "query unavailable offline"
                                         : String(e));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
      if (pageRequestRef.current === requestId) pageRequestRef.current = null;
    }
  };

  useEffect(() => {
    if (capped) return;
    const requestId = ++requestIdRef.current;
    pageRequestRef.current = null;
    setGroups([]);
    setTotal(null);
    setOffset(0);
    setError(null);
    void load(0, requestId);
    // load(0) reads only `expr`/`capped` from scope; re-run on those alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expr, capped]);

  const loadMore = () => {
    if (pageRequestRef.current !== null) return;
    const requestId = ++requestIdRef.current;
    pageRequestRef.current = requestId;
    void load(offset, requestId);
  };

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
        <button className="show-more btn-secondary" onClick={loadMore} disabled={loading}>
          {loading ? "Loading…" : "Show more"}
        </button>
      )}
    </div>
  );
}
