// pattern: Functional Core
// The editor's keydown policy, in two halves: decideEditorKey for a focused
// block's textarea (BlockInput reads the live DOM and autocomplete state),
// and decideSelectionKey for a multi-block selection, which has no textarea
// and is keyed by the tree container itself (EditableBlockTree). Both are
// pure: the shells hand in key + modifiers + state and execute the returned
// semantic decision. All DOM effects (preventDefault, blur, navigation,
// setState) stay in the shells. Ordering mirrors the former inline onKeyDown
// chains exactly, so behaviour is unchanged.
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
  /** Whether the collapsed caret sits on the first VISUAL (display) line of
   * a soft-wrapped textarea, as measured by the shell. `undefined` when
   * unmeasured (jsdom, or the shell chose not to measure) — boundary-arrow
   * decisions then fall back to the logical-newline-only heuristic. */
  caretOnFirstDisplayLine?: boolean;
  /** Same as caretOnFirstDisplayLine, for the last visual line. */
  caretOnLastDisplayLine?: boolean;
}

export type KeyDecision =
  | { type: "ac-move"; selected: number }
  | { type: "ac-pick" }
  | { type: "ac-close" }
  | { type: "blur" }
  /** sidebar: Ctrl-Shift-O — open in the sidebar (same as shift-clicking a
   * wiki link) instead of navigating the main pane. */
  | { type: "navigate-ref"; title: string; sidebar: boolean }
  | { type: "start-block-selection"; dir: "up" | "down" }
  | { type: "select-to-block-edge"; edge: "start" | "end" }
  /** Replace the textarea selection with this exact range (pkm-jgtn:
   * line-wise Shift+Cmd+Left/Right). direction matches setSelectionRange's,
   * so the moving end stays the one further presses keep extending. */
  | { type: "select-range"; selStart: number; selEnd: number;
      direction: "backward" | "forward" }
  | { type: "select-whole-block" }
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
const NONE_SELECTION: SelectionKeyDecision = { type: "none" };

/** Offset of the first character of the LOGICAL line containing `pos`. */
const lineStartAt = (text: string, pos: number): number =>
  pos <= 0 ? 0 : text.lastIndexOf("\n", pos - 1) + 1;

/** Offset just past the last character of the logical line containing `pos`
 * (i.e. the index of its "\n", or text.length on the final line). */
const lineEndAt = (text: string, pos: number): number => {
  const nl = text.indexOf("\n", pos);
  return nl < 0 ? text.length : nl;
};

export type AutocompleteKeyAction = "move-up" | "move-down" | "pick" | "close";

/** Whether an open autocomplete popup should claim this keydown, and what it
 * should do. Only unmodified Arrow/Enter/Tab/Escape are consumed — any
 * Cmd/Ctrl/Shift/Alt combination is left for native selection/navigation or
 * editor commands instead (pkm-clt1). Shared by decideEditorKey (the outline
 * editor) and Composer so both agree on the same modifier boundary rather
 * than each re-deriving it. */
export function autocompleteKeyAction(k: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): AutocompleteKeyAction | null {
  if (k.metaKey || k.ctrlKey || k.altKey || k.shiftKey) return null;
  if (k.key === "ArrowDown") return "move-down";
  if (k.key === "ArrowUp") return "move-up";
  if (k.key === "Enter" || k.key === "Tab") return "pick";
  if (k.key === "Escape") return "close";
  return null;
}

// Modifier convention: letter-chord editing shortcuts are Meta-only with
// Ctrl/Alt/Shift excluded — Ctrl+letter is left to the emacs-style textarea
// bindings macOS provides (Ctrl-K kill-line, Ctrl-B back-char, ...), and
// Shift chords stay free for future shortcuts. (Shift-Cmd-V is one such:
// it deliberately falls through this policy as NONE — the shell observes
// its keydown to arm the outline-paste split, but the browser's own paste
// must still fire, so there is no decision to make here. See paste.ts.)
// Only shortcuts mirroring a
// system-wide convention (undo/redo, todo-cycle on Enter) accept Meta or
// Ctrl so they also work on non-Mac keyboards.
const META_WRAP_EDITS: Partial<Record<string,
  (text: string, selStart: number, selEnd: number) => TextSelection>> = {
  k: wrapLink,
  b: (t, s, e) => toggleEmphasis(t, s, e, "**"),
  i: (t, s, e) => toggleEmphasis(t, s, e, "__"),
};

type Modifiers = Pick<EditorKeyInput, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** Shift+Cmd with no Ctrl/Alt: the subtree-move (line 177 below) and
 * line-wise selection (line ~187) chords share this exact shape. */
const isShiftMetaOnly = (i: Modifiers): boolean =>
  i.shiftKey && i.metaKey && !i.ctrlKey && !i.altKey;

/** Meta or Ctrl, with no Alt/Shift: undo/redo's 'z' and the todo-cycle
 * Enter chord share this exact shape (Ctrl accepted alongside Meta so both
 * also work on non-Mac keyboards, per the module-level convention above). */
const isMetaOrCtrlOnly = (i: Modifiers): boolean =>
  (i.metaKey || i.ctrlKey) && !i.altKey && !i.shiftKey;

export function decideEditorKey(i: EditorKeyInput): KeyDecision {
  const pos = i.selStart;
  const caretOnly = i.selStart === i.selEnd;

  // Option/Alt+Arrow belongs to native text navigation. Catch every modifier
  // variant before autocomplete, Shift selection, or boundary-arrow handling
  // can claim it.
  if (i.altKey && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    return NONE;
  }
  // Ctrl+Cmd+Arrow is the selection chord (pkm-am54): Left/Right select from
  // the caret to the block's start/end (the whole logical block, not the
  // display line native selection stops at); Up/Down lift the caret into a
  // whole-block selection that further presses extend (the tree container
  // owns those once the selection exists). Selection is read-only-safe, and
  // like Option+Arrow above this precedes the autocomplete popup's claim on
  // vertical arrows.
  if (i.ctrlKey && i.metaKey && !i.altKey && !i.shiftKey) {
    if (i.key === "ArrowLeft") {
      return { type: "select-to-block-edge", edge: "start" };
    }
    if (i.key === "ArrowRight") {
      return { type: "select-to-block-edge", edge: "end" };
    }
    if (i.key === "ArrowUp" || i.key === "ArrowDown") {
      return { type: "select-whole-block" };
    }
  }
  // Autocomplete popup owns the unmodified arrows / Enter / Tab / Escape while open.
  if (i.acRowsLength > 0) {
    const acAction = autocompleteKeyAction(i);
    if (acAction === "move-down") {
      return { type: "ac-move", selected: Math.min(i.acSelected + 1, i.acRowsLength - 1) };
    }
    if (acAction === "move-up") {
      return { type: "ac-move", selected: Math.max(i.acSelected - 1, 0) };
    }
    if (acAction === "pick") return { type: "ac-pick" };
    if (acAction === "close") return { type: "ac-close" };
  }
  if (i.key === "Escape") return { type: "blur" };
  // Ctrl-O inside a [[page reference]] opens that page (Meta/Alt left alone);
  // Ctrl-Shift-O opens it in the sidebar instead, mirroring shift-click on a
  // rendered wiki link (PageLink.tsx). The target page may not exist server
  // side yet — the shell (BlockInput) creates it before navigating.
  if (i.ctrlKey && !i.metaKey && !i.altKey && i.key.toLowerCase() === "o") {
    const title = refTitleAtCaret(i.draft, pos);
    if (title) return { type: "navigate-ref", title, sidebar: i.shiftKey };
  }
  // Shift+Cmd+Arrow is the sole application movement chord: move the
  // block's whole subtree (pkm-hx2w). It must be caught before the plain-
  // Shift block-selection-start check below (same shiftKey+Arrow shape), and
  // like any mutation it is read-only-gated.
  if (isShiftMetaOnly(i) && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
    if (i.readOnly) return NONE;
    return i.key === "ArrowUp" ? { type: "move-subtree-up" } : { type: "move-subtree-down" };
  }
  // Shift+Cmd+Left/Right select line-wise (pkm-jgtn): first press selects to
  // the start/end of the LOGICAL line (like Ctrl+Cmd+Left/Right, not the
  // display line the native binding stops at), and each further press adds
  // one whole line — native's "select to line start" is a dead end on the
  // second press. Selection is read-only-safe, hence before the cutoff.
  if (isShiftMetaOnly(i) && (i.key === "ArrowLeft" || i.key === "ArrowRight")) {
    if (i.key === "ArrowLeft") {
      const start = lineStartAt(i.draft, pos);
      const target = start < pos ? start
        : start > 0 ? lineStartAt(i.draft, start - 1) : null;
      if (target === null) return NONE;
      return { type: "select-range", selStart: target, selEnd: i.selEnd,
               direction: "backward" };
    }
    const end = lineEndAt(i.draft, i.selEnd);
    const target = end > i.selEnd ? end
      : end < i.draft.length ? lineEndAt(i.draft, end + 1) : null;
    if (target === null) return NONE;
    return { type: "select-range", selStart: pos, selEnd: target,
             direction: "forward" };
  }
  // Plain Shift+Up/Down at the block's vertical edge starts a multi-block
  // selection; copying is read-only-safe so this precedes the cut. The edge
  // is measured at the end that would move (selStart going up, selEnd going
  // down), so a live text selection escalates to a block selection the
  // moment it can no longer grow within the block (pkm-jgtn) — it must never
  // fall into the boundary-arrow rules, which would drop it. Meta/Ctrl
  // variants are excluded: Ctrl+Shift+Up is native select-to-paragraph-start
  // and must stay with the platform.
  if (i.shiftKey && !i.metaKey && !i.ctrlKey
      && (i.key === "ArrowUp" || i.key === "ArrowDown")) {
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
    // Deliberately not isMetaOrCtrlOnly below: Shift is part of THIS decision
    // (Cmd-Z vs Shift-Cmd-Z), not excluded from it.
    return i.shiftKey ? { type: "redo" } : { type: "undo" };
  }
  // Cmd-Alt-1/2/3 set heading levels 1-3, Cmd-Alt-0 clears back to plain
  // text, matching Google Docs' ⌥⌘1/2/3 and ⌥⌘0 (pkm-bt9h). Matched on
  // `i.code` (Digit0-3) rather than `i.key`: on macOS, Option+digit produces
  // special glyphs in `key` (e.g. Option-1 -> "¡"), so only the physical
  // key code is reliable — `key` is kept only as a jsdom/test fallback when
  // `code` is unavailable.
  const headingDigit = /^Digit([0-3])$/.exec(i.code)?.[1]
    ?? (/^[0-3]$/.test(i.key) ? i.key : null);
  if (i.metaKey && i.altKey && !i.ctrlKey && !i.shiftKey && headingDigit !== null) {
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
  if (isMetaOrCtrlOnly(i) && i.key === "Enter") {
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
  // Boundary arrows move focus between blocks — but only unmodified:
  // Meta/Ctrl/Alt arrows are native text navigation (Cmd-Left = caret to
  // line start, ...) and Shift arrows are selection (native within the
  // block, block selection at the edges above) — hijacking any of them into
  // block navigation would preventDefault the native behaviour or silently
  // drop a live selection (pkm-jgtn).
  if (i.metaKey || i.ctrlKey || i.altKey || i.shiftKey) return NONE;
  // The logical-newline check alone can't see soft-wrapping: a block with no
  // "\n" at all still spans several VISUAL lines, and the caret should move
  // up/down within it before focus jumps to the neighbouring block. The
  // shell measures the real display line when it can; `!== false` keeps the
  // old newline-only behaviour when unmeasured (jsdom, or a bail-out).
  if (i.key === "ArrowUp" && !i.draft.slice(0, pos).includes("\n")
      && i.caretOnFirstDisplayLine !== false) {
    return { type: "arrow", dir: "up" };
  }
  if (i.key === "ArrowDown" && !i.draft.slice(i.selEnd).includes("\n")
      && i.caretOnLastDisplayLine !== false) {
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

export interface SelectionKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  readOnly: boolean;
}

export type SelectionKeyDecision =
  | { type: "indent-selection" }
  | { type: "outdent-selection" }
  | { type: "move-selection"; dir: "up" | "down" }
  | { type: "extend-selection"; dir: "up" | "down" }
  | { type: "copy-selection" }
  | { type: "clear-selection" }
  | { type: "delete-selection" }
  /** Collapse the selection back into editing its head block at offset 0. */
  | { type: "focus-selection-head" }
  | { type: "none" };

/** The keydown policy while a multi-block selection is active. There is no
 * focused textarea then — the tree container holds focus and owns these keys.
 *
 * Two invariants the shell depends on:
 * - Every decision other than "none" is preventDefault-ed by the shell, and
 *   "none" leaves the event uncancelled for the platform.
 * - Creating, extending, copying and dismissing a selection are
 *   read-only-safe; every MUTATING branch (indent/outdent, move, delete) is
 *   gated on !readOnly and degrades to "none" (pkm-rckh: a selection made
 *   while editable outlives the switch to read-only, and used to stay
 *   destroyable). useOutline's handlers do not re-check editability, so this
 *   gate is the only one. */
export function decideSelectionKey(i: SelectionKeyInput): SelectionKeyDecision {
  const verticalArrow = i.key === "ArrowUp" || i.key === "ArrowDown";
  const dir = i.key === "ArrowUp" ? "up" : "down";
  if (i.key === "Tab") {
    if (i.readOnly) return NONE_SELECTION;
    return i.shiftKey ? { type: "outdent-selection" } : { type: "indent-selection" };
  }
  // Shift+Cmd+Arrow moves the selected blocks; checked before the plain-Shift
  // extend below, which has the same shiftKey+Arrow shape.
  if (i.shiftKey && i.metaKey && !i.ctrlKey && !i.altKey && verticalArrow) {
    return i.readOnly ? NONE_SELECTION : { type: "move-selection", dir };
  }
  if (i.shiftKey && !i.metaKey && !i.ctrlKey && !i.altKey && verticalArrow) {
    return { type: "extend-selection", dir };
  }
  // Ctrl+Cmd+Up/Down keeps extending the selection it started (pkm-am54).
  if (i.ctrlKey && i.metaKey && !i.shiftKey && !i.altKey && verticalArrow) {
    return { type: "extend-selection", dir };
  }
  if ((i.metaKey || i.ctrlKey) && i.key.toLowerCase() === "c") {
    return { type: "copy-selection" };
  }
  if (i.key === "Escape") return { type: "clear-selection" };
  if (i.key === "Backspace" || i.key === "Delete") {
    return i.readOnly ? NONE_SELECTION : { type: "delete-selection" };
  }
  if (!i.shiftKey && !i.metaKey && !i.ctrlKey && !i.altKey && verticalArrow) {
    return { type: "focus-selection-head" };
  }
  return NONE_SELECTION;
}
