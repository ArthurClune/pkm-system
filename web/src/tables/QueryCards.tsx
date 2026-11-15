// pattern: Imperative Shell
// A query's records as cards: the table's rows and columns, read-only.
import { island } from "./island";
import { CellValue, RecordLink, RecordSource } from "./recordCells";
import type { QueryColumn, ShownRow } from "./queryView";

export function QueryCards({ rows, columns, depth }: {
  rows: ShownRow[];
  columns: QueryColumn[];
  depth: number;
}) {
  return (
    <div className="query-cards" {...island}>
      {rows.map(({ record, stale }) => (
        <article key={record.key}
                 className={"query-card" + (stale ? " stale" : "")}>
          <h4 className="query-card-title"><RecordLink record={record} /></h4>
          <RecordSource record={record} />
          {columns.map((c) => {
            const cell = record.cells[c.key];
            if (!cell || cell.value.trim() === "") return null;
            return (
              <div key={c.name} className="query-card-row">
                <span className="query-card-key">{c.label}</span>
                <span><CellValue cell={cell} depth={depth} /></span>
              </div>
            );
          })}
          {stale && <span className="data-table-stale-label">no longer matches</span>}
        </article>
      ))}
    </div>
  );
}
