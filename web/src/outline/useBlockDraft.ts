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
   * intended initial caret and later prop changes must not re-run it. */
  cursor: number;
  /** Report an edit to the outline (which debounces the autosave).
   * holdFlush (pkm-xlah): the caret sits mid [[ref / #tag token, so the
   * debounced autosave must wait — flushing now would create a page from the
   * half-typed title. */
  onEdit(text: string, holdFlush: boolean): void;
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
}

export function useBlockDraft(
  { text, cursor, onEdit, onAdopt }: BlockDraftOptions,
): BlockDraft {
  const [draft, setDraft] = useState(text);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const initialCursorRef = useRef(cursor);
  // Whether the user has typed edits not yet committed to the block tree.
  // Focus alone is not a draft: while dirty, remote text still lands on the
  // tree but the textarea keeps the local draft (last-write-wins); with no
  // dirty draft the textarea adopts tree changes. draftRef mirrors `draft` so
  // the adoption effect can read it without re-subscribing on every keystroke.
  const dirtyRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Set between compositionstart/end: an IME composition in progress. Remote
  // adoption must not call setDraft mid-composition (it would disturb the
  // native composition UI), so it's deferred and retried on compositionend.
  const composingRef = useRef(false);
  // Caret offset to restore once an adoption's setDraft has committed (see
  // the layout effect below); null when no restore is pending.
  const pendingCaretRef = useRef<number | null>(null);
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
    const at = Math.min(initialCursorRef.current, el.value.length);
    el.setSelectionRange(at, at);
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
      pendingCaretRef.current = clampCaret(el.selectionStart ?? 0, text.length);
    }
    onAdoptRef.current();
    setDraft(text);
  };
  useEffect(tryAdopt, [text]);

  // Restore the caret after an adoption's setDraft has committed to the DOM
  // (a plain value swap would otherwise leave the browser's default of
  // moving the caret to the end of the new text).
  useLayoutEffect(() => {
    const at = pendingCaretRef.current;
    if (at === null) return;
    pendingCaretRef.current = null;
    ref.current?.setSelectionRange(at, at);
  }, [draft]);

  return {
    ref,
    text: draft,
    typed: (next, holdFlush) => {
      dirtyRef.current = true;
      setDraft(next);
      onEdit(next, holdFlush);
    },
    replace: (next, selStart, selEnd, holdFlush) => {
      dirtyRef.current = true;
      setDraft(next);
      onEdit(next, holdFlush);
      // place the cursor after React commits the new value
      requestAnimationFrame(() => {
        ref.current?.setSelectionRange(selStart, selEnd);
      });
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: () => {
      composingRef.current = false;
      tryAdopt();
    },
  };
}
