// pattern: Imperative Shell
// The focused block's draft session: the textarea's live value, IME
// composition state, and the adoption of block-tree text over a clean draft.
// Whether the value is dirty is not its to record: the outline's pending
// draft for the block (`pendingDraft`) is the one answer.
// It owns the textarea element ref and every caret placement that follows a
// programmatic value change, because those two are the same concern — a value
// swap that doesn't restore the caret sends it to the end of the text.
//
// It is where an edit past the text limits (grammar/textLimits.ts), or
// holding a ref whose title the server refuses, is refused: the textarea
// keeps its old text and the caller is told why. The one exception is the
// title the caret is in while the flush is held, which the outline judges
// when it saves the draft (useOutline's run).
//
// It does NOT know about autocomplete, slash commands, uploads or the /date
// picker: callers decide what the new text is and whether its flush is held,
// this only holds it and reports it.
import { useEffect, useLayoutEffect, useRef, useState,
         type MutableRefObject } from "react";
import { textLimitNotice, textLimitViolation } from "../grammar/textLimits";
import { linkedTitleRefusal, titleRefusalNotice } from "../replica/titles";
import { clampCaret, refusedEditCaret } from "./edits";
import type { ResumedDraft } from "./handlers";
import { heightChanged, mayHaveShrunk } from "./textareaHeight";

// Computed once per module load, not per block: `field-sizing: content`
// (styles.css, `.block-input`) makes the browser do the auto-grow natively,
// so where it's supported the JS measure-and-set below is dead weight this
// skips entirely. Supported since Chromium 123 and Safari 26.2 (desktop and
// iPadOS) as of this writing -- the fallback below exists for
// older engines. jsdom has a `CSS` global but no `CSS.supports`, hence the
// extra function check (a bare call would throw in every unit test).
const supportsFieldSizing =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

// WebKit ends a composition before dispatching the keydown that committed
// it, and sends that keydown with isComposing false and keyCode 229. So the
// first keydown after a compositionend is the IME's when it is 229 and close
// in time. 229 alone is not enough: a 229 keydown can arrive with no
// composition just ended, and must not lose its Enter. The window bounds a
// composition ended without a key (a candidate clicked): the next
// keydown, seconds later, is the user's.
const IME_COMMIT_WINDOW_MS = 500;

/** The clock the window is measured on; tests replace `now`. */
export const imeClock = { now: (): number => performance.now() };

/** The fields of a keydown that say whether the IME owns it. */
export type ImeKeydown = Pick<KeyboardEvent, "isComposing" | "keyCode"
  | "timeStamp">;

export interface BlockDraftOptions {
  /** The block tree's committed text for this block. */
  text: string;
  /** Caret offset to place on mount. Captured once: the input is remounted
   * each time focus moves to a new block, so the mount-time value is the
   * intended initial caret and later prop changes must not re-run it. A
   * resumed draft ignores it: its caret goes back where the previous textarea
   * left it, or to the end of the draft when that was not recorded. */
  cursor: number;
  /** The outline's pending draft for this block, or null. The textarea is
   * dirty exactly while there is one: the tree's text does not replace it,
   * and an edit reports no new draft start (onDirty), so the draft keeps its
   * base. A textarea mounting over one resumes it: its text is read once, at
   * the first render; its selection is read again at mount, because the
   * textarea it replaces reports its selection (onUnmount) in the same
   * commit that mounts this one, after this one has rendered. */
  pendingDraft(): ResumedDraft | null;
  /** Subscribe to the end of the pending draft (OutlineHandlers'
   * subscribeDraftEnd); read once, at mount. */
  subscribeDraftEnd(listener: () => void): () => void;
  /** The textarea is unmounting with this selection. */
  onUnmount(selStart: number, selEnd: number): void;
  /** Report an edit to the outline (which debounces the autosave).
   * holdFlush: the caret sits mid [[ref / #tag token, so the
   * debounced autosave must wait — flushing now would create a page from the
   * half-typed title. */
  onEdit(text: string, holdFlush: boolean): void;
  /** Called before the first onEdit of a clean draft with the text the
   * textarea showed until then: the text the user is typing over. */
  onDirty(shown: string): void;
  /** Called when committed text is adopted over the draft: the replacement
   * text invalidates any offset into the old text the caller remembered. */
  onAdopt(): void;
  /** An edit was refused for a text limit or for a ref to a title the
   * server refuses; `notice` says which. */
  onRefused(notice: string): void;
}

export interface BlockDraft {
  /** The textarea this draft is bound to; the caller renders the element. */
  ref: MutableRefObject<HTMLTextAreaElement | null>;
  /** The textarea's current value. */
  text: string;
  /** Record what the user typed (the change event). No caret placement — the
   * browser has already put the caret where it belongs. */
  typed(text: string, holdFlush: boolean): void;
  /** May the draft become `next`? False when `next` is past a text limit
   * or holds a ref to a title the server refuses (linkedTitleRefusal, which
   * leaves out the title `heldCaret` is inside when the flush is held): the
   * refusal is reported (onRefused) and the draft is unchanged. When the
   * textarea already shows `next` (a typed change), the caret goes back to
   * where the refused text first differs from the draft's. */
  admit(next: string, heldCaret: number | null): boolean;
  /** Replace the draft programmatically (key edit, completion, /date
   * insertion) and restore `selStart..selEnd` once React has committed the
   * new value. A changed text is judged by admit first; returns its
   * answer. */
  replace(text: string, selStart: number, selEnd: number,
          holdFlush: boolean): boolean;
  onCompositionStart(): void;
  onCompositionEnd(e: { timeStamp: number }): void;
  /** Whether the IME owns this keydown, which the editor must then leave
   * alone: one sent mid-composition, or the keystroke that ended one. Call
   * it once per keydown, since it consumes the composition just ended. */
  imeOwns(e: ImeKeydown): boolean;
  /** The draft has been committed and the tree has since changed this block
   * for the user (undo, redo, an upload filling it): adopt the tree's text
   * once it has rendered. Without it, the textarea would keep showing the old
   * text, and the next draft would be typed over text the tree no longer
   * holds. */
  settle(): void;
}

export function useBlockDraft(
  { text, cursor, onEdit, onDirty, onAdopt, onRefused, pendingDraft,
    subscribeDraftEnd, onUnmount }: BlockDraftOptions,
): BlockDraft {
  const [resumedText] = useState(() => pendingDraft()?.text ?? null);
  const [draft, setDraft] = useState(resumedText ?? text);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const initialCursorRef = useRef(cursor);
  const resumingRef = useRef(resumedText !== null);
  const pendingDraftRef = useRef(pendingDraft);
  pendingDraftRef.current = pendingDraft;
  const onUnmountRef = useRef(onUnmount);
  onUnmountRef.current = onUnmount;
  // Focus alone is not a draft: while one is pending, remote text still lands
  // on the tree but the textarea keeps the local draft (the draft's flush
  // carries its base hash, so the server keeps the remote text as a conflict
  // copy); with none the textarea adopts tree changes. draftRef mirrors
  // `draft` so the adoption effect can read it without re-subscribing on
  // every keystroke.
  const dirty = () => pendingDraftRef.current() !== null;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Set between compositionstart/end: an IME composition in progress. Remote
  // adoption must not call setDraft mid-composition (it would disturb the
  // native composition UI), so it's deferred and retried on compositionend.
  const composingRef = useRef(false);
  // The compositionend's timeStamp until the next keydown, else null.
  const compositionEndedAtRef = useRef<number | null>(null);
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
      : pendingDraftRef.current()?.selection ?? { start: len, end: len };
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
  // keystroke forces two synchronous layouts (measured 3/keystroke,
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
    if (text === draftRef.current || dirty() || composingRef.current) return;
    const el = ref.current;
    if (el && document.activeElement === el) {
      const at = clampCaret(el.selectionStart ?? 0, text.length);
      pendingSelectionRef.current = { start: at, end: at };
    }
    onAdoptRef.current();
    setDraft(text);
  };
  // settle() and the end of the pending draft bump this so adoption also runs
  // when the tree's text for this block ends up where it started (an undo of
  // a draft that had not yet reached the tree, or a flush that sent nothing
  // while remote text landed under the draft), which leaves `text` unchanged.
  const [settled, setSettled] = useState(0);
  useEffect(tryAdopt, [text, settled]);
  const subscribeRef = useRef(subscribeDraftEnd);
  useEffect(() => subscribeRef.current(() => setSettled((n) => n + 1)), []);

  // Restore the selection once a setDraft has committed to the DOM (a plain
  // value swap would otherwise leave the browser's default of moving the
  // caret to the end of the new text). A layout effect, never a
  // requestAnimationFrame: React commits a discrete event's update
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
    if (!dirty()) onDirty(draftRef.current);
  };

  const admit = (next: string, heldCaret: number | null): boolean => {
    // The text limits first: the ref scan must never read past them.
    const violation = textLimitViolation(next);
    const notice = violation !== null ? textLimitNotice(violation)
      : titleRefusalNotice(linkedTitleRefusal(next, heldCaret));
    if (notice === null) return true;
    onRefused(notice);
    const el = ref.current;
    if (el && el.value === next) {
      // The browser has already put the refused text in the textarea and
      // React puts the draft back once the handler returns, sending the
      // caret to the end. A microtask runs after that restore and before
      // the next event, so the caret is back before another key lands.
      const at = refusedEditCaret(draftRef.current, next);
      queueMicrotask(() => el.setSelectionRange(at, at));
    }
    return false;
  };

  return {
    ref,
    text: draft,
    admit,
    typed: (next, holdFlush) => {
      markDirty();
      setDraft(next);
      onEdit(next, holdFlush);
    },
    replace: (next, selStart, selEnd, holdFlush) => {
      if (next !== draftRef.current
          && !admit(next, holdFlush ? selEnd : null)) {
        return false;
      }
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
      return true;
    },
    onCompositionStart: () => {
      composingRef.current = true;
    },
    onCompositionEnd: (e) => {
      composingRef.current = false;
      compositionEndedAtRef.current = e.timeStamp;
      tryAdopt();
    },
    imeOwns: (e) => {
      const endedAt = compositionEndedAtRef.current;
      compositionEndedAtRef.current = null;
      if (e.isComposing || composingRef.current) return true;
      return e.keyCode === 229 && endedAt !== null
        && Math.abs(e.timeStamp - endedAt) < IME_COMMIT_WINDOW_MS;
    },
    settle: () => setSettled((n) => n + 1),
  };
}
