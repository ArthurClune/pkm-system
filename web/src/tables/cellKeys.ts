// pattern: Functional Core
// What a keystroke in the table cell editor means. Tab is the editor's own
// even while a list is open: Tab moves between cells, unlike the outline's
// popup, where Tab picks.

export interface CellKey {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  composing: boolean;
}

/** The open suggestion list. `floor` is the lowest highlight: -1 when the
 * list may sit with no row highlighted, so Enter still commits. `closable`
 * lists (page titles) take Esc for themselves before it cancels the edit. */
export interface CellList {
  rows: number;
  selected: number;
  floor: 0 | -1;
  closable: boolean;
}

export type CellKeyDecision =
  | { kind: "none" }
  | { kind: "commit" }
  | { kind: "cancel" }
  | { kind: "tab"; dir: 1 | -1 }
  | { kind: "move"; selected: number }
  | { kind: "pick" }
  | { kind: "close-list" };

const NONE: CellKeyDecision = { kind: "none" };

export function decideCellKey(k: CellKey, list: CellList | null): CellKeyDecision {
  if (k.composing) return NONE;
  if (k.key === "Tab") {
    return k.metaKey || k.ctrlKey || k.altKey ? NONE
      : { kind: "tab", dir: k.shiftKey ? -1 : 1 };
  }
  const plain = !k.metaKey && !k.ctrlKey && !k.altKey && !k.shiftKey;
  if (!plain) return NONE;
  const open = list !== null && list.rows > 0 ? list : null;
  switch (k.key) {
    case "ArrowDown":
      return open ? { kind: "move", selected: Math.min(open.selected + 1, open.rows - 1) }
        : NONE;
    case "ArrowUp":
      return open ? { kind: "move", selected: Math.max(open.selected - 1, open.floor) }
        : NONE;
    case "Enter":
      return open && open.selected >= 0 ? { kind: "pick" } : { kind: "commit" };
    case "Escape":
      return open?.closable ? { kind: "close-list" } : { kind: "cancel" };
    default:
      return NONE;
  }
}
