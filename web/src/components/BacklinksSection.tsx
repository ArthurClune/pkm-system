// pattern: Imperative Shell
import { useContext, useState } from "react";
import { apiFetch } from "../api/client";
import type { BacklinkGroup, Backlinks, BlockRefText, PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { encodeTitle } from "../paths";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";

export function BacklinksSection({ title, initial }:
    { title: string; initial: Backlinks }) {
  const base = useContext(BlockRefContext);
  const [groups, setGroups] = useState<BacklinkGroup[]>(initial.groups);
  const [extraRefTexts, setExtraRefTexts] =
    useState<Record<string, BlockRefText>>({});
  const [loading, setLoading] = useState(false);
  const hasMore = groups.length < initial.total_pages;

  const loadMore = async () => {
    setLoading(true);
    try {
      // bl pagination counts source pages; groups.length is the next offset.
      const p = await apiFetch<PagePayload>(
        `/api/page/${encodeTitle(title)}?bl_offset=${groups.length}&bl_limit=${initial.limit}`);
      setGroups((g) => [...g, ...p.backlinks.groups]);
      setExtraRefTexts((m) => ({ ...m, ...p.block_ref_texts }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <BlockRefContext.Provider value={{ ...base, ...extraRefTexts }}>
      <section className="backlinks">
        <h2 className="section-header">Linked references ({initial.total_pages})</h2>
        {groups.map((g) => (
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
        {hasMore && (
          <button className="show-more" onClick={() => void loadMore()} disabled={loading}>
            {loading ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </BlockRefContext.Provider>
  );
}
