// pattern: Functional Core
// The keydown policy for a focused block's textarea. EditableBlockTree reads
// the live DOM (key, modifiers, caret, selection) and the current autocomplete
// state, hands them here, and executes the returned semantic decision. All
// DOM effects (preventDefault, blur, navigation, setState) stay in the shell;
// this module only decides. Ordering mirrors the former inline onKeyDown chain
// exactly, so behaviour is unchanged.
import { cycleTodo } from "../grammar/todo";
import { autoPairBracket, BRACKET_CHARS, toggleEmphasis, wrapLink,
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
  | { type: "split"; cursor: number }
  | { type: "indent" }
  | { type: "outdent" }
  | { type: "move-subtree-up" }
  | { type: "move-subtree-down" }
  | { type: "backspace-at-start" }
  | { type: "arrow"; dir: "up" | "down" | "left" | "right" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "none" };

const NONE: KeyDecision = { type: "none" };

// Modifier convention: letter-chord editing shortcuts are Meta-only with
// Ctrl/Alt/Shift excluded — Ctrl+letter is left to the emacs-style textarea
// bindings macOS provides (Ctrl-K kill-line, Ctrl-B back-char, ...), and
// Shift chords stay free for future shortcuts. Only shortcuts mirroring a
// system-wide convention (undo/redo, todo-cycle on Enter) accept Meta or
// Ctrl so they also work on non-Mac keyboards.
const META_WRAP_EDITS: Partial<Record<string,
  (text: string, selStart: number, selEnd: number) => TextSelection>> = {
  k: wrapLink,
  b: (t, s, e) => toggleEmphasis(t, s, e, "**"),
  i: (t, s, e) => toggleEmphasis(t, s, e, "__"),
};

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
  // Shift+Cmd+Arrow is the sole application movement chord: move the
  // block's whole subtree (pkm-hx2w). It must be caught before the plain-
  // Shift block-selection-start check below (same shiftKey+Arrow shape), and
  // like any mutation it is read-only-gated.
  if (i.shiftKey && i.metaKey && !i.ctrlKey && !i.altKey
      && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    if (i.readOnly) return NONE;
    return i.key === "ArrowUp" ? { type: "move-subtree-up" } : { type: "move-subtree-down" };
  }
  // Option/Alt+Arrow belongs to native text navigation. Catch every modifier
  // variant before Shift selection or boundary-arrow handling can claim it.
  if (i.altKey && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    return NONE;
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
  // Cmd-Z / Shift-Cmd-Z (Ctrl variants for non-Mac): app-level undo/redo
  // (pkm-7q14). preventDefault in the shell kills the textarea's native
  // undo, which would otherwise fight the op-based history.
  if ((i.metaKey || i.ctrlKey) && !i.altKey && i.key.toLowerCase() === "z") {
    return i.shiftKey ? { type: "redo" } : { type: "undo" };
  }
  const headingDigit = /^Digit([0-3])$/.exec(i.code)?.[1]
    ?? (/^[0-3]$/.test(i.key) ? i.key : null);
  if (i.ctrlKey && i.altKey && !i.metaKey && !i.shiftKey && headingDigit !== null) {
    return {
      type: "set-heading",
      heading: headingDigit === "0" ? null : Number(headingDigit),
    };
  }
  const wrapEdit = META_WRAP_EDITS[i.key.toLowerCase()];
  if (wrapEdit && i.metaKey && !i.ctrlKey && !i.altKey && !i.shiftKey) {
    return { type: "key-edit", edit: wrapEdit(i.draft, pos, i.selEnd) };
  }
  if (!i.metaKey && !i.ctrlKey && !i.altKey && BRACKET_CHARS.has(i.key)) {
    const edit = autoPairBracket(i.draft, pos, i.selEnd, i.key);
    if (edit) return { type: "key-edit", edit };
  }
  // Cmd-Enter (Ctrl-Enter on non-Mac) cycles plain -> TODO -> DONE -> plain.
  // Treated as a key-edit on the live draft (not the block-tree text) so the
  // textarea updates synchronously and the change rides the normal draft
  // pipeline — a debounced flush that lands after this can only see the
  // cycled text, never revert it. Checked before plain Enter so the modifier
  // wins over a split. The caret shifts by the same delta as the text length
  // change, clamped to the new text, to stay near where the user was.
  if ((i.metaKey || i.ctrlKey) && !i.altKey && !i.shiftKey && i.key === "Enter") {
    const cycled = cycleTodo(i.draft);
    const caret = Math.max(0, Math.min(cycled.length,
      pos + (cycled.length - i.draft.length)));
    return { type: "key-edit", edit: { text: cycled, selStart: caret, selEnd: caret } };
  }
  if (i.key === "Enter" && !i.shiftKey) return { type: "split", cursor: pos };
  if (i.key === "Tab") return i.shiftKey ? { type: "outdent" } : { type: "indent" };
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
