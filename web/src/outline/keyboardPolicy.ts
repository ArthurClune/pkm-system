// pattern: Functional Core
// The keydown policy for a focused block's textarea. EditableBlockTree reads
// the live DOM (key, modifiers, caret, selection) and the current autocomplete
// state, hands them here, and executes the returned semantic decision. All
// DOM effects (preventDefault, blur, navigation, setState) stay in the shell;
// this module only decides. Ordering mirrors the former inline onKeyDown chain
// exactly, so behaviour is unchanged.
import { autoPairBracket, BRACKET_CHARS, wrapLink,
         type TextSelection } from "./keyEdits";
import { refTitleAtCaret } from "./refAtCaret";

export interface EditorKeyInput {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Caret / selection anchor offset (textarea.selectionStart). */
  selStart: number;
  /** Selection focus offset (textarea.selectionEnd). */
  selEnd: number;
  draft: string;
  readOnly: boolean;
  /** Number of visible autocomplete rows (0 when the popup is closed). */
  acRowsLength: number;
  /** Currently highlighted autocomplete row. */
  acSelected: number;
}

export type KeyDecision =
  | { type: "ac-move"; selected: number }
  | { type: "ac-pick" }
  | { type: "ac-close" }
  | { type: "blur" }
  | { type: "navigate-ref"; title: string }
  | { type: "start-block-selection"; dir: "up" | "down" }
  | { type: "set-heading"; heading: number | null }
  | { type: "key-edit"; edit: TextSelection }
  | { type: "cycle-todo" }
  | { type: "split"; cursor: number }
  | { type: "indent" }
  | { type: "outdent" }
  | { type: "move-up" }
  | { type: "move-down" }
  | { type: "backspace-at-start" }
  | { type: "arrow"; dir: "up" | "down" | "left" | "right" }
  | { type: "none" };

const NONE: KeyDecision = { type: "none" };

export function decideEditorKey(i: EditorKeyInput): KeyDecision {
  const pos = i.selStart;
  const caretOnly = i.selStart === i.selEnd;

  // Autocomplete popup owns the arrows / Enter / Tab / Escape while open.
  if (i.acRowsLength > 0) {
    if (i.key === "ArrowDown") {
      return { type: "ac-move", selected: Math.min(i.acSelected + 1, i.acRowsLength - 1) };
    }
    if (i.key === "ArrowUp") {
      return { type: "ac-move", selected: Math.max(i.acSelected - 1, 0) };
    }
    if (i.key === "Enter" || i.key === "Tab") return { type: "ac-pick" };
    if (i.key === "Escape") return { type: "ac-close" };
  }
  if (i.key === "Escape") return { type: "blur" };
  // Ctrl-O inside a [[page reference]] opens that page (Meta/Alt left alone).
  if (i.ctrlKey && !i.metaKey && !i.altKey && i.key.toLowerCase() === "o") {
    const title = refTitleAtCaret(i.draft, pos);
    if (title) return { type: "navigate-ref", title };
  }
  // Shift+Arrow at the block's vertical edge (collapsed caret) starts a
  // multi-block selection; copying is read-only-safe so this precedes the cut.
  if (i.shiftKey && caretOnly && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    const up = i.key === "ArrowUp";
    const atEdge = up ? !i.draft.slice(0, pos).includes("\n")
                      : !i.draft.slice(i.selEnd).includes("\n");
    if (atEdge) return { type: "start-block-selection", dir: up ? "up" : "down" };
  }
  if (i.readOnly) return NONE;
  const headingDigit = /^Digit([0-3])$/.exec(i.code)?.[1]
    ?? (/^[0-3]$/.test(i.key) ? i.key : null);
  if (i.ctrlKey && i.altKey && !i.metaKey && !i.shiftKey && headingDigit !== null) {
    return {
      type: "set-heading",
      heading: headingDigit === "0" ? null : Number(headingDigit),
    };
  }
  if (i.metaKey && !i.ctrlKey && !i.altKey && i.key.toLowerCase() === "k") {
    return { type: "key-edit", edit: wrapLink(i.draft, pos, i.selEnd) };
  }
  if (!i.metaKey && !i.ctrlKey && !i.altKey && BRACKET_CHARS.has(i.key)) {
    const edit = autoPairBracket(i.draft, pos, i.selEnd, i.key);
    if (edit) return { type: "key-edit", edit };
  }
  // Cmd-Enter (Ctrl-Enter on non-Mac) cycles plain -> TODO -> DONE -> plain;
  // checked before plain Enter so the modifier wins over a split.
  if ((i.metaKey || i.ctrlKey) && !i.altKey && !i.shiftKey && i.key === "Enter") {
    return { type: "cycle-todo" };
  }
  if (i.key === "Enter" && !i.shiftKey) return { type: "split", cursor: pos };
  if (i.key === "Tab") return i.shiftKey ? { type: "outdent" } : { type: "indent" };
  if (i.altKey && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    return i.key === "ArrowUp" ? { type: "move-up" } : { type: "move-down" };
  }
  if (i.key === "Backspace" && pos === 0 && caretOnly) {
    return { type: "backspace-at-start" };
  }
  if (i.key === "ArrowUp" && !i.draft.slice(0, pos).includes("\n")) {
    return { type: "arrow", dir: "up" };
  }
  if (i.key === "ArrowDown" && !i.draft.slice(i.selEnd).includes("\n")) {
    return { type: "arrow", dir: "down" };
  }
  if (i.key === "ArrowLeft" && pos === 0 && caretOnly) {
    return { type: "arrow", dir: "left" };
  }
  if (i.key === "ArrowRight" && pos === i.draft.length && caretOnly) {
    return { type: "arrow", dir: "right" };
  }
  return NONE;
}
