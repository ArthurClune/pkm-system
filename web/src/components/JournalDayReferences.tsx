// pattern: Imperative Shell
// Surfaces a daily page's linked references inline in the journal scroll
// (pkm-vvta): "Remind me on [[July 28th, 2026]]" should be visible under
// that day without clicking through to the page. Reuses BacklinksSection
// (pkm-m4an's include/exclude filter and all) rather than a new renderer --
// this component's only job is the "has any references at all" gate that
// keeps empty days uncluttered.
//
// The references arrive with the day, in /api/journal's payload. They used to
// be a per-day GET /api/page/{title}?bl_limit=5 from here, which made a scroll
// of N days cost N page reads -- 26 of them for a 12 s scroll, each re-fetching
// blocks the journal payload had already delivered (pkm-5fak). BacklinksSection
// still pages the rest from /api/page on demand; that is a click, not a scroll.
import type { Backlinks } from "../api/payloads";
import { BacklinksSection } from "./BacklinksSection";

export function JournalDayReferences(
  { title, backlinks }: { title: string; backlinks: Backlinks },
) {
  if (backlinks.total_pages === 0) return null;
  return <BacklinksSection title={title} initial={backlinks} />;
}
