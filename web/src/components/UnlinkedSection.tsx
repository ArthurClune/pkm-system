// pattern: Imperative Shell
import { useState } from "react";
import { apiFetch } from "../api/client";
import type { BlockGroup, GroupsPayload } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";
import { mergeGroups } from "./groups";

const PAGE_SIZE = 20;

export function UnlinkedSection({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<BlockGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (from: number) => {
    setLoading(true);
    setError(null);
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/unlinked?title=${encodeURIComponent(title)}&limit=${PAGE_SIZE}&offset=${from}`);
      setGroups((g) => mergeGroups(g, p.groups));
      setTotal(p.total);
      // /api/unlinked paginates by blocks: advance by items received.
      setOffset(from + p.groups.reduce((n, gr) => n + gr.items.length, 0));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && total === null) void load(0); // lazy: fetch on first open only
  };

  return (
    <section className="unlinked">
      <h2 className="section-header collapsible" onClick={toggle}>
        <span className={"chevron" + (open ? "" : " closed")}>▸</span>
        {" "}Unlinked references{total !== null ? ` (${total})` : ""}
      </h2>
      {open && (
        <>
          {groups.map((g) => (
            <div className="backlink-group" key={g.page_id}>
              <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
              {g.items.map((item) => (
                <div className="backlink-item" key={item.uid}>
                  <div className="backlink-text">
                    <InlineSegments segments={tokenizeBlock(item.text)} />
                  </div>
                </div>
              ))}
            </div>
          ))}
          {error && <p className="error">{error}</p>}
          {total !== null && offset < total && (
            <button className="show-more" onClick={() => void load(offset)} disabled={loading}>
              {loading ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
