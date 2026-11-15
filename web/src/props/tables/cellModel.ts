// pattern: Functional Core
// The cell editor model, written from the tables-and-queries design's
// "Editing" section and never from cellEditor.ts:
// - clicking a cell opens it with its stored value; clicking the open cell
//   again changes nothing;
// - Enter, a click elsewhere, Tab and opening another cell close the open
//   cell and write its draft, outer whitespace trimmed, unless that equals
//   the stored value trimmed; Esc closes it and writes nothing;
// - Tab and Shift-Tab then open the next or previous editable cell in
//   row-major order, or nothing past either end;
// - with no cell open, only a click does anything.
import type { CellRef, EditorEvent } from "../../tables/cellEditor";

export interface OpenCell {
  readonly cell: CellRef;
  readonly original: string;
  readonly draft: string;
}

export interface CellModel {
  readonly open: OpenCell | null;
}

export interface ModelWrite {
  readonly cell: CellRef;
  readonly value: string;
}

export const cellKey = (c: CellRef): string => `${c.row}/${c.col}`;

/** What closing `open` writes: nothing when the draft, trimmed, is the
 * stored value trimmed. */
export function closeWrites(open: OpenCell): ModelWrite[] {
  const trimmed = open.draft.trim();
  if (trimmed === open.original.trim()) return [];
  return [{ cell: open.cell, value: trimmed }];
}

export function modelEvent(m: CellModel, e: EditorEvent):
    { model: CellModel; writes: ModelWrite[] } {
  const open = m.open;
  if (open === null) {
    if (e.kind !== "open") return { model: m, writes: [] };
    return { model: { open: { cell: e.cell, original: e.value, draft: e.value } }, writes: [] };
  }
  if (e.kind === "input") return { model: { open: { ...open, draft: e.draft } }, writes: [] };
  if (e.kind === "cancel") return { model: { open: null }, writes: [] };
  if (e.kind === "open" && cellKey(e.cell) === cellKey(open.cell)) {
    return { model: m, writes: [] };
  }
  let next: OpenCell | null = null;
  if (e.kind === "open") next = { cell: e.cell, original: e.value, draft: e.value };
  if (e.kind === "tab" && e.next !== null) {
    next = { cell: e.next.cell, original: e.next.value, draft: e.next.value };
  }
  return { model: { open: next }, writes: closeWrites(open) };
}

/** The editable cell `dir` steps from `cur` in `order`, or null. */
export function modelNeighbour(order: readonly CellRef[], cur: CellRef,
                               dir: 1 | -1): CellRef | null {
  const keys = order.map(cellKey);
  const at = keys.indexOf(cellKey(cur));
  if (at < 0) return null;
  const to = at + dir;
  return to >= 0 && to < order.length ? order[to] : null;
}
