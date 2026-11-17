// pattern: Imperative Shell
// What a query record shows in a table cell or a card: its title as a link
// (to the page, or to the line on its page), the page a line sits on, and a
// `::` value with the badges for what the cell leaves out.
import { useContext } from "react";
import { useNavigate } from "react-router";
import type { RawTitle } from "../api/brands";
import type { QueryRecordModel, RecordCell } from "../api/payloads";
import { InlineSegments } from "../components/InlineSegments";
import { PageLink } from "../components/PageLink";
import { CellMediaContext, InertMediaContext, SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { pagePath } from "../paths";

/** A line's text renders as the outline shows it; a click on it, outside
 * the links it holds, opens the line on its page. */
export function RecordLink({ record, depth }:
    { record: QueryRecordModel; depth: number }) {
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);
  if (record.kind === "page" || record.uid === null) {
    return <PageLink title={record.page_title} tag={false} />;
  }
  const uid = record.uid;
  const go = (sidebar: boolean) => {
    if (sidebar) openInSidebar(record.page_title, uid);
    else void navigate(`${pagePath(record.page_title)}#${uid}`);
  };
  return (
    <span className="query-line" role="link" tabIndex={0}
          onClick={(e) => {
            if ((e.target as Element).closest("a, .block-ref")) return;
            e.stopPropagation();
            go(e.shiftKey);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.target === e.currentTarget) {
              e.preventDefault();
              go(e.shiftKey);
            }
          }}>
      <InertMediaContext.Provider value={true}>
        <InlineSegments segments={tokenizeBlock(record.row_title)}
                        depth={depth} />
      </InertMediaContext.Provider>
    </span>
  );
}

export function RecordSource({ record }: { record: QueryRecordModel }) {
  if (record.kind === "page") return null;
  return (
    <div className="query-source">
      line on <PageLink title={record.page_title} tag={false} />
    </div>
  );
}

export function CellValue({ cell, page, depth }:
    { cell: RecordCell; page: RawTitle; depth: number }) {
  const lines = 1 + (cell.extra_uids ?? []).length;
  const children = cell.child_count ?? 0;
  return (
    <>
      <CellMediaContext.Provider value={{ table: "query", page, uid: cell.uid }}>
        <InlineSegments segments={tokenizeBlock(cell.value)} depth={depth} />
      </CellMediaContext.Provider>
      {lines > 1 && (
        <span className="query-cell-badge"
              title={`${lines} ${cell.key_raw}:: lines; an edit changes the first`}>
          {lines} lines
        </span>
      )}
      {children > 0 && (
        <span className="query-cell-badge"
              title="Lines under this value, not shown or edited here">
          +{children} lines
        </span>
      )}
    </>
  );
}
