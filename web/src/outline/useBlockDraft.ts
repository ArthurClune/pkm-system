// pattern: Imperative Shell
// The focused block's draft session: the textarea's live value, whether that
// value is dirty (typed but not yet committed to the block tree), IME
// composition state, and the adoption of block-tree text over a clean draft.
// It owns the textarea element ref and every caret placement that follows a
// programmatic value change, because those two are the same concern — a value
// swap that doesn't restore the caret sends it to the end of the text.
//
// It does NOT know about autocomplete, slash commands, uploads or the /date
// picker: callers decide what the new text is and whether its flush is held,
// this only holds it and reports it (pkm-64bq).
import { useEffect, useLayoutEffect, useRef, useState,
         type MutableRefObject } from "react";
import { clampCaret } from "./edits";
import type { ResumedDraft } from "./handlers";
import { heightChanged, mayHaveShrunk } from "./textareaHeight";

// Computed once per module load, not per block: `field-sizing: content`
// (styles.css, `.block-input`) makes the browser do the auto-grow natively,
// so where it's supported the JS measure-and-set below is dead weight this
// skips entirely. Supported since Chromium 123 and Safari 26.2 (desktop and
// iPadOS) as of this writing (pkm-youp) -- the fallback below exists for
// older engines. jsdom has a `CSS` global but no `CSS.supports`, hence the
// extra function check (a bare call would throw in every unit test).
const supportsFieldSizing =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

export interface BlockDraftOptions {
  /** The block tree's committed text for this block. */
  text: string;
  /** Caret offset to place on mount. Captured once: the input is remounted
   * each time focus moves to a new block, so the mount-time value is the
   * intended initial caret and later prop changes must not re-run it. A
   * resumed draft ignores it: its caret goes back where the previous textarea
   * left it, or to the end of the draft when that was not recorded. */
  cursor: number;
  /** The pending draft this textarea takes over, or null. Its text is read
   * once, at the first render; its selection is read again at mount, because
   * the textarea it replaces reports its selection (onUnmount) in the same
   * commit that mounts this one, after this one has rendered. A resumed draft
   * starts dirty, so the tree's text does not replace it, and its first edit
   * reports no new draft start (onDirty), so the draft keeps its base. */
  resume(): ResumedDraft | null;
  /** The textarea is unmounting with this selection. */
  onUnmount(selStart: number, selEnd: number): void;
  /** Report an edit to the outline (which debounces the autosave).
   * holdFlush (pkm-xlah): the caret sits mid [[ref / #tag token, so the
   * debounced autosave must wait — flushing now would create a page from the
   * half-typed title. */
  onEdit(text: string, holdFlush: boolean): void;
  /** Called before the first onEdit of a clean draft with the text the
   * textarea showed until then: the text the user is typing over. */
  onDirty(shown: string): void;
  /** Called when committed text is adopted over the draft: the replacement
   * text invalidates any offset into the old text the caller remembered. */
  onAdopt(): void;
}

export interface BlockDraft {
  /** The textarea this draft is bound to; the caller renders the element. */
  ref: MutableRefObject<HTMLTextAreaElement | null>;
  /** The textarea's current value. */
  text: string;
  /** Record what the user typed (the change event). No caret placement — the
   * browser has already put the caret where it belongs. */
  typed(text: string, holdFlush: boolean): void;
  /** Replace the draft programmatically (key edit, completion, /date
   * insertion) and restore `selStart..selEnd` once React has committed the
   * new value. */
  replace(text: string, selStart: number, selEnd: number,
          holdFlush: boolean): void;
  onCompositionStart(): void;
  onCompositionEnd(): void;
  /** The draft has been committed and the tree has since changed this block
   * for the user (undo, redo, an upload splice): mark it clean and adopt the
   * tree's text once it has rendered. Left dirty, the textarea would keep
   * showing the old text, and the next draft would be typed over text the
   * tree no longer holds. */
  settle(): void;
}

export function useBlockDraft(
  { text, cursor, onEdit, onDirty, onAdopt, resume,
    onUnmount }: BlockDraftOptions,
): BlockDraft {
  const [resumedText] = useState(() => resume()?.text ?? null);
  const [draft, setDraft] = useState(resumedText ?? text);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const initialCursorRef = useRef(cursor);
  const resumingRef = useRef(resumedText !== null);
  const resumeRef = useRef(resume);
  resumeRef.current = resume;
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  // Whether the user has typed edits not yet committed to the block tree.
  // Focus alone is not a draft: while dirty, remote text still lands on the
  // tree but the textarea keeps the local draft (the draft's flush carries its
  // base hash, so the server keeps the remote text as a conflict copy); with
  // no dirty draft the textarea adopts tree changes. draftRef mirrors `draft` so
  // the adoption effect can read it without re-subscribing on every keystroke.
  const dirtyRef = useRef(resumedText !== null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Set between compositionstart/end: an IME composition in progress. Remote
  // adoption must not call setDraft mid-composition (it would disturb the
  // native composition UI), so it's deferred and retried on compositionend.
  const composingRef = useRef(false);
  // Selection to restore once a setDraft (an adoption or a programmatic
  // replace) has committed (see the layout effect below); null when no
  // restore is pending.
  const pendingSelectionRef =
    useRef<{ start: number; end: number } | null>(null);
  // Held in a ref, not read as a dep: adoption is driven by the committed
  // text changing, and must not re-run just because the caller re-created its
  // callback on a render.
  const onAdoptRef = useRef(onAdopt);
  onAdoptRef.current = onAdopt;

  // Take focus + place the cursor once on mount (the caller's component
  // exists only while its block is the focused one).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    const sel = !resumingRef.current
      ? { start: initialCursorRef.current, end: initialCursorRef.current }
      : resumeRef.current()?.selection ?? { start: len, end: len };
    el.setSelectionRange(Math.min(sel.start, len), Math.min(sel.end, len));
  }, []);

  // A layout cleanup runs while the element is still in the document, and
  // before the effects of a textarea mounting in the same commit.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    return () => onUnmountRef.current(el.selectionStart, el.selectionEnd);
  }, []);

  // Auto-grow to fit content. Skipped entirely where `field-sizing: content`
  // is supported -- the CSS does this natively with no forced layout from
  // here. Otherwise: a naive "reset to auto, then measure" on every
  // keystroke forces two synchronous layouts (pkm-youp measured 3/keystroke,
  // 20% of a core at typing speed on a 300-block page). `heightAppliedRef`
  // and `heightTextRef` let the fallback pay for the reset only when the
  // content may have shrunk (textareaHeight.ts) and pay for the write only
  // when the measured height actually differs.
  const heightAppliedRef = useRef<number | null>(null);
  const heightTextRef = useRef(draft);
  useEffect(() => {
    const el = ref.current;
    if (!el || supportsFieldSizing) return;
    const prevText = heightTextRef.current;
    heightTextRef.current = draft;
    if (mayHaveShrunk(prevText, draft)) el.style.height = "auto";
    const measured = el.scrollHeight;
    if (heightChanged(measured, heightAppliedRef.current)) {
      el.style.height = `${measured}px`;
      heightAppliedRef.current = measured;
    }
  }, [draft]);

  // Adopt block-tree text changes — a remote update, or our own draft landing
  // after a flush — unless an unflushed local draft should win. Committed text
  // matching the draft means our edit committed (or we're already in sync), so
  // the draft is no longer dirty. Deferred while composing (see composingRef);
  // retried from onCompositionEnd below so a remote update that arrived
  // mid-composition still lands once the IME is done.
  const tryAdopt = () => {
    if (text === draftRef.current) {
      dirtyRef.current = false;
      return;
    }
    if (dirtyRef.current || composingRef.current) return;
    const el = ref.current;
    if (el && document.activeElement === el) {
      const at = clampCaret(el.selectionStart ?? 0, text.length);
      pendingSelectionRef.current = { start: at, end: at };
    }
    onAdoptRef.current();
    setDraft(text);
  };
  // settle() bumps this so adoption also runs when the tree's text for this
  // block ends up where it started (an undo of a draft that had not yet
  // reached the tree), which leaves `text` unchanged.
  const [settled, setSettled] = useState(0);
  useEffect(tryAdopt, [text, settled]);

  // Restore the selection once a setDraft has committed to the DOM (a plain
  // value swap would otherwise leave the browser's default of moving the
  // caret to the end of the new text). A layout effect, never a
  // requestAnimationFrame (pkm-j7ez): React commits a discrete event's update
  // before the next event is dispatched, so the caret is right before any
  // further keystroke can land. A frame callback runs later than that under
  // load, and would move a caret the user has since typed past back to the
  // offset captured at replace time -- /h1 then typing left the caret at 0,
  // and Enter split the heading's text off into the block below.
  useLayoutEffect(() => {
    const sel = pendingSelectionRef.current;
    if (sel === null) return;
    pendingSelectionRef.current = null;
    ref.current?.setSelectionRange(sel.start, sel.end);
  }, [draft]);

  // draftRef, not the tree's text: until the adoption effect has run, the
  // textarea still shows the text before a remote change, and that is what
  // the user is typing over.
  const markDirty = () => {
    if (!dirtyRef.current) onDirty(draftRef.current);
    dirtyRef.current = true;
  };

  return {
    ref,
    text: draft,
    typed: (next, holdFlush) => {
      markDirty();
      setDraft(next);
      onEdit(next, holdFlush);
    },
    replace: (next, selStart, selEnd, holdFlush) => {
      markDirty();
      const el = ref.current;
      if (el && el.value === next) {
        // Selection-only edit (skipping over an auto-inserted closer): there
        // is no commit to wait for, and no re-render to run the effect.
        el.setSelectionRange(selStart, selEnd);
      } else {
        pendingSelectionRef.current = { start: selStart, end: selEnd };
      }
      setDraft(next);
      onEdit(next, holdFlush);
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      tryAdopt();
    },
    settle: () => {
      dirtyRef.current = false;
      setSettled((n) => n + 1);
    },
  };
}
