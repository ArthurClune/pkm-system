// pattern: Functional Core
// Normalize Roam table macro trees into rectangular row data for later renderers.
import type { BlockNode } from "../api/payloads";

export type RoamTableRows = (BlockNode | null)[][];

const TABLE_MACRO = /^(?:\{\{table\}\}|\{\{\[\[table\]\]\}\})$/i;

export function roamTableRows(node: BlockNode): RoamTableRows | null {
  if (!TABLE_MACRO.test(node.text.trim()) || node.children.length === 0) return null;

  const rows: BlockNode[][] = [];
  for (const first of node.children) {
    const row: BlockNode[] = [];
    let cell: BlockNode | undefined = first;
    while (cell) {
      row.push(cell);
      if (cell.children.length > 1) return null;
      cell = cell.children[0];
    }
    rows.push(row);
  }

  const width = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => null),
  ]);
}
