// pattern: Imperative Shell
import { Fragment, useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { OfflineError } from "../api/client";
import { apiGet } from "../api/typedClient";
import type { QueryGroup } from "../api/payloads";
import { useStaleGuard } from "../useStaleGuard";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { SidebarContext } from "../contexts";
import { pagePath } from "../paths";
import { MISSING_ANCESTOR_TEXT } from "./groups";
import { PageLink } from "./PageLink";

// A query whose results contain another {{query}} (e.g. a self-matching
// block) would otherwise re-mount an identical QueryBlock and recurse
// forever, fetch after fetch. Same guard idea as BlockRef's MAX_DEPTH.
const MAX_DEPTH = 2;

export function QueryBlock({ expr, depth = 0 }: { expr: string; depth?: number }) {
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);
  const capped = depth >= MAX_DEPTH;
  const [groups, setGroups] = useState<QueryGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Every expression load is stamped with a stale-response token. A response
  // is applied only if it is still current when it resolves; this drops
  // stale responses even when the offline gateway does not honor an
  // AbortController.
  const guard = useStaleGuard();

  const load = useCallback(async (token: number) => {
    try {
      const p = await apiGet("/api/query", { query: { expr } });
      if (guard.isStale(token)) return;
      setGroups(p.groups);
      setTotal(p.total);
      setError(null);
    } catch (e: unknown) {
      if (guard.isStale(token)) return;
      // query blocks are online-only in v1
      setError(e instanceof OfflineError ? "query unavailable offline"
                                         : String(e));
    }
  }, [expr, guard]);

  useEffect(() => {
    if (capped) return;
    const token = guard.begin();
    setGroups([]);
    setTotal(null);
    setError(null);
    void load(token);
  }, [capped, load, guard]);

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
              {item.ancestors && item.ancestors.length > 0 && (
                <div className="breadcrumbs">
                  {item.ancestors.map((at, i) => {
                    const uid = g.ancestor_uids?.[at];
                    const text = g.ancestor_texts?.[at] ?? MISSING_ANCESTOR_TEXT;
                    const href = `${pagePath(g.page_title)}#${uid ?? ""}`;
                    return (
                      <Fragment key={i}>
                        {i > 0 && " › "}
                        <a className="query-crumb" href={href}
                           onClick={(e) => {
                             e.preventDefault();
                             e.stopPropagation();
                             if (e.shiftKey && uid) openInSidebar(g.page_title, uid);
                             else void navigate(href);
                           }}>{text}</a>
                      </Fragment>
                    );
                  })}
                </div>
              )}
              <InlineSegments segments={tokenizeBlock(item.text)} depth={depth + 1} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
