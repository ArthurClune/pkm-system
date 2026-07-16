// pattern: Imperative Shell
// Semantic table shell composing the context-aware inline render pipeline.
import { tokenizeBlock } from "../grammar/tokenize";
import { InlineSegments } from "./InlineSegments";
import type { RoamTableRows } from "./roamTableRows";

export function RoamTable({ rows }: { rows: RoamTableRows }) {
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
              <td key={cell?.uid ?? `empty-${rowIndex}-${cellIndex}`}>
                {cell ? content(cell.text) : null}
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
