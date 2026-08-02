// pattern: Imperative Shell
// Surfaces a daily page's linked references inline in the journal scroll
// (pkm-vvta): "Remind me on [[July 28th, 2026]]" should be visible under
// that day without clicking through to the page. Reuses BacklinksSection
// (pkm-m4an's include/exclude filter and all) rather than a new renderer --
// this component's only job is the per-day lazy fetch and the "has any
// references at all" gate that keeps empty days uncluttered.
import { useContext, useEffect, useState } from "react";
import { apiGet } from "../api/typedClient";
import type { PagePayload } from "../api/payloads";
import { BlockRefContext } from "../contexts";
import { BacklinksSection } from "./BacklinksSection";

// A scroll full of days each showing every referencing page would be noisy;
// BacklinksSection's own "Show more"/filter-panel loadAll still reaches the
// rest on demand. This also keeps the URL distinct from a plain parent-page
// read of the same title (PageView, or Journal's own day-blocks fetch) --
// the two are otherwise indistinguishable requests when a page happens to
// be open in both places at once.
const PREVIEW_LIMIT = 5;

export function JournalDayReferences({ title }: { title: string }) {
  const base = useContext(BlockRefContext);
  const [backlinks, setBacklinks] = useState<PagePayload["backlinks"] | null>(null);
  const [refTexts, setRefTexts] = useState<PagePayload["block_ref_texts"]>({});

  useEffect(() => {
    let cancelled = false;
    // The journal already has this day's blocks (via the outline session);
    // this fetch is only for the backlinks/block_ref_texts side of the
    // same payload, and runs after the day itself has rendered -- it never
    // blocks the journal's initial paint. A failure (offline, deleted
    // underneath us) just means no references section for this day.
    apiGet("/api/page/{title}", {
      path: { title },
      query: { bl_limit: PREVIEW_LIMIT },
    })
      .then((p) => {
        if (cancelled) return;
        setBacklinks(p.backlinks);
        setRefTexts(p.block_ref_texts);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [title]);

  if (!backlinks || backlinks.total_pages === 0) return null;
  return (
    <BlockRefContext.Provider value={{ ...base, ...refTexts }}>
      <BacklinksSection title={title} initial={backlinks} />
    </BlockRefContext.Provider>
  );
}
