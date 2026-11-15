// pattern: Functional Core
// The cell editor both table kinds share: which cell is open, its value when
// opened and the reader's draft, and the writes that closing it owes. Enter,
// a click elsewhere and Tab commit; Esc cancels. A draft that differs from
// the original only by outer whitespace writes nothing.

export interface CellRef { row: string; col: string }

export type EditorState =
  | { kind: "idle" }
  | { kind: "editing"; cell: CellRef; original: string; draft: string };

export type EditorEvent =
  | { kind: "open"; cell: CellRef; value: string }
  | { kind: "input"; draft: string }
  | { kind: "commit" }
  | { kind: "cancel" }
  | { kind: "outside" }
  | { kind: "tab"; dir: 1 | -1; next: { cell: CellRef; value: string } | null };

export type EditorEffect = { kind: "write"; cell: CellRef; value: string };

type Editing = Extract<EditorState, { kind: "editing" }>;

const IDLE: EditorState = { kind: "idle" };

const sameCell = (a: CellRef, b: CellRef): boolean => a.row === b.row && a.col === b.col;

const opened = (cell: CellRef, value: string): EditorState =>
  ({ kind: "editing", cell, original: value, draft: value });

function closing(s: Editing): EditorEffect[] {
  const value = s.draft.trim();
  return value === s.original.trim() ? [] : [{ kind: "write", cell: s.cell, value }];
}

export function stepEditor(s: EditorState, e: EditorEvent):
    { state: EditorState; effects: EditorEffect[] } {
  if (s.kind === "idle") {
    return e.kind === "open" ? { state: opened(e.cell, e.value), effects: [] }
      : { state: s, effects: [] };
  }
  switch (e.kind) {
    case "open":
      return sameCell(s.cell, e.cell) ? { state: s, effects: [] }
        : { state: opened(e.cell, e.value), effects: closing(s) };
    case "input":
      return { state: { ...s, draft: e.draft }, effects: [] };
    case "commit":
    case "outside":
      return { state: IDLE, effects: closing(s) };
    case "cancel":
      return { state: IDLE, effects: [] };
    case "tab":
      return {
        state: e.next === null ? IDLE : opened(e.next.cell, e.next.value),
        effects: closing(s),
      };
  }
}

/** The editable cell after (`dir` 1) or before (-1) `cur` in `order`, the
 * editable cells in row-major order as rendered; null past either end or
 * when `cur` is not in `order`. */
export function neighbourCell(order: readonly CellRef[], cur: CellRef,
                              dir: 1 | -1): CellRef | null {
  const at = order.findIndex((cell) => sameCell(cell, cur));
  return at === -1 ? null : order[at + dir] ?? null;
}
