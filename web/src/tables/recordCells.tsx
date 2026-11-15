// pattern: Imperative Shell
// What a query record shows in a table cell or a card: its title as a link
// (to the page, or to the line on its page), the page a line sits on, and a
// `::` value with the badges for what the cell leaves out.
import { useContext } from "react";
import { useNavigate } from "react-router";
import type { QueryRecordModel, RecordCell } from "../api/payloads";
import { InlineSegments } from "../components/InlineSegments";
import { PageLink } from "../components/PageLink";
import { SidebarContext } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { pagePath } from "../paths";

export function RecordLink({ record }: { record: QueryRecordModel }) {
  const navigate = useNavigate();
  const { openInSidebar } = useContext(SidebarContext);
  if (record.kind === "page" || record.uid === null) {
    return <PageLink title={record.page_title} tag={false} />;
  }
  const uid = record.uid;
  const href = `${pagePath(record.page_title)}#${uid}`;
  return (
    <a className="query-crumb" href={href}
       onClick={(e) => {
         e.preventDefault();
         e.stopPropagation();
         if (e.shiftKey) openInSidebar(record.page_title, uid);
         else void navigate(href);
       }}>{record.row_title}</a>
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

export function CellValue({ cell, depth }: { cell: RecordCell; depth: number }) {
  const lines = 1 + (cell.extra_uids ?? []).length;
  return (
    <>
      <InlineSegments segments={tokenizeBlock(cell.value)} depth={depth} />
      {lines > 1 && (
        <span className="query-cell-badge"
              title={`${lines} ${cell.key_raw}:: lines; an edit changes the first`}>
          {lines} lines
        </span>
      )}
      {cell.child_count > 0 && (
        <span className="query-cell-badge"
              title="Lines under this value, not shown or edited here">
          +{cell.child_count} lines
        </span>
      )}
    </>
  );
}
