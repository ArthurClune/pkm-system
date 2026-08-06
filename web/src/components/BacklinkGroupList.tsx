// pattern: Imperative Shell
// The one renderer for backlink-group markup (pkm-d31f): BacklinksSection
// and the block-reference popover both render through here — same
// precedent as JournalDayReferences reusing BacklinksSection rather than
// growing a second renderer.
import type { BacklinkGroup } from "../api/payloads";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";

export function BacklinkGroupList({ groups, onNavigate }: {
  groups: BacklinkGroup[];
  /** When set, each item becomes a navigation target (the popover);
   * without it, items render inertly (the backlinks section, where
   * navigation lives on the inline links themselves). */
  onNavigate?: (pageTitle: string, uid: string) => void;
}) {
  return (
    <>
      {groups.map((g) => (
        <div className="backlink-group" key={g.page_id}>
          <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
          {g.items.map((item) => (
            <div className={"backlink-item" + (onNavigate ? " navigable" : "")}
                 key={item.uid}
                 role={onNavigate ? "link" : undefined}
                 tabIndex={onNavigate ? 0 : undefined}
                 onClick={onNavigate ? (e) => {
                   // leave clicks on nested anchors/refs to their own handlers
                   if ((e.target as Element).closest("a, .block-ref")) return;
                   onNavigate(g.page_title, item.uid);
                 } : undefined}
                 onKeyDown={onNavigate ? (e) => {
                   if (e.key === "Enter" && e.target === e.currentTarget) {
                     e.preventDefault();
                     onNavigate(g.page_title, item.uid);
                   }
                 } : undefined}>
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
    </>
  );
}
