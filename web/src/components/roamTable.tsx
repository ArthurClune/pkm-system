// pattern: Imperative Shell
// A {{table}} block. Its rows render at once as a plain table; the sort,
// filter and cell editing (PlainTable.tsx) load on the first table rendered
// and replace it, so a page without a table never pays for them in the
// entry chunk, and nothing moves while they load. Until then a click on the
// table reaches the block row and opens its text, as before. Its body cells
// show media and carry data-cell-uid as PlainTable's do, so the swap
// neither fetches media nor misses a jump to a cell.
import { CellMediaContext, type CellMediaTarget } from "../contexts";
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import { lazyLoader, useLazy } from "./lazyComponent";
import type { RoamTableRows } from "../outline/roamTableRows";
import type { PlainTableProps } from "./PlainTable";

const PLAIN_CELL: CellMediaTarget = { table: "plain" };
const loadPlainTable = lazyLoader(() => import("./tablesChunk").then((m) => m.PlainTable));

export function RoamTable(props: PlainTableProps) {
  const loaded = useLazy(loadPlainTable);
  if (loaded.status === "ok") {
    const Plain = loaded.value;
    return <Plain {...props} />;
  }
  return <StaticTable rows={props.rows} />;
}

function StaticTable({ rows }: { rows: RoamTableRows }) {
  const [header, ...body] = rows;
  const content = (text: string) =>
    <InlineSegments segments={tokenizeBlock(text)} />;

  return (
    <div className="roam-table-scroll">
      <table className="roam-table">
        <thead><tr>{header.map((cell, index) => (
          <th key={cell?.uid ?? `empty-header-${index}`} scope="col">
            {cell ? content(cell.text) : null}
          </th>
        ))}</tr></thead>
        <tbody>{body.map((row, rowIndex) => (
          <tr key={row.find((cell) => cell)?.uid ?? `empty-row-${rowIndex}`}>
            {row.map((cell, cellIndex) => (
              <td key={cell?.uid ?? `empty-${rowIndex}-${cellIndex}`}
                  data-cell-uid={cell?.uid}>
                <div className="table-cell">
                  {cell ? (
                    <CellMediaContext.Provider value={PLAIN_CELL}>
                      {content(cell.text)}
                    </CellMediaContext.Provider>
                  ) : null}
                </div>
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
