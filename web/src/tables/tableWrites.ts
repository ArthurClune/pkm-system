// pattern: Functional Core
// The ops a plain {{table}} block's edits make. A table is its rows' child
// chains (outline/roamTableRows.ts), so a cell is a block, and a short row's
// padding cells have no block until a write creates the chain down to them.
import type { BlockUid, RawTitle } from "../api/brands";
import type { CreateOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { freshChildOrderIdx, orderIdxAfterLast } from "../outline/orderIdx";
import type { RoamTableRows } from "../outline/roamTableRows";

export type TableCellWrite =
  | { kind: "text"; uid: BlockUid; text: string }
  | { kind: "create"; ops: CreateOp[] };

/** A chain of `texts.length` blocks, each the only child of the one before,
 * the first placed under `parent` at `orderIdx`. */
function chain(parent: BlockUid, orderIdx: CreateOp["order_idx"],
               texts: readonly string[], mint: () => BlockUid,
               pageTitle: RawTitle): CreateOp[] {
  const ops: CreateOp[] = [];
  let parentUid = parent;
  texts.forEach((text, i) => {
    const uid = mint();
    ops.push({ op: "create", uid, page_title: pageTitle, parent_uid: parentUid,
               order_idx: i === 0 ? orderIdx : freshChildOrderIdx(0), text });
    parentUid = uid;
  });
  return ops;
}

/** Writing `value` into row `r`, column `c` of `rows` (the header is row
 * 0): the cell's new text, the blocks a padding cell needs, or null when
 * nothing changes. */
export function planTableCellWrite(rows: RoamTableRows, r: number, c: number,
                                   value: string, mint: () => BlockUid,
                                   pageTitle: RawTitle): TableCellWrite | null {
  const row = rows[r];
  if (row === undefined || c < 0 || c >= row.length) return null;
  const cell = row[c];
  if (cell) {
    return cell.text === value ? null : { kind: "text", uid: cell.uid, text: value };
  }
  if (value === "") return null;
  // A row's first cell is a child of the table, so a padding cell always
  // has a real cell before it, and that one has no children.
  let last = c - 1;
  while (row[last] === null) last--;
  const tail = row[last]!;
  const texts = [...Array.from({ length: c - last - 1 }, () => ""), value];
  return { kind: "create",
           ops: chain(tail.uid, orderIdxAfterLast(tail.children), texts, mint,
                      pageTitle) };
}

/** A new last row of `table`: `width` empty cells. */
export function planNewRow(table: BlockNode, width: number,
                           mint: () => BlockUid, pageTitle: RawTitle): CreateOp[] {
  return chain(table.uid, orderIdxAfterLast(table.children),
               Array.from({ length: width }, () => ""), mint, pageTitle);
}
