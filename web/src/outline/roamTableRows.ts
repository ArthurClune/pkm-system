// pattern: Functional Core
// Normalize Roam table macro trees into rectangular row data for later
// renderers.
import type { BlockNode } from "../api/payloads";
import { tableMacroOptions, type MacroOptions } from "../grammar/macroOptions";

export type RoamTableRows = (BlockNode | null)[][];

export function roamTableRows(node: BlockNode): RoamTableRows | null {
  return roamTable(node)?.rows ?? null;
}

/** The table's rows and the options its macro carries
 * (`{{table | sort: Lab desc}}`), or null when the block is not a table. */
export function roamTable(
  node: BlockNode,
): { rows: RoamTableRows; options: MacroOptions } | null {
  const options = tableMacroOptions(node.text);
  if (options === null || node.children.length === 0) return null;

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
  return {
    rows: rows.map((row) => [
      ...row,
      ...Array.from({ length: width - row.length }, () => null),
    ]),
    options,
  };
}
