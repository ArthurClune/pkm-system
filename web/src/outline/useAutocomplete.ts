// pattern: Imperative Shell
// The autocomplete popup's state, shared by the outline editor's BlockInput
// and the phone Composer: which completion context is open, which row is
// highlighted, and — the reason it is shared — resolving the context to act
// on from the textarea's LIVE selection rather than the one the last input
// event captured (pkm-noow). Detection and the staleness rule are pure and
// live in autocomplete.ts; this only holds React state and reads the DOM.
import { useState, type Dispatch, type SetStateAction } from "react";
import { detectAutocomplete, liveAcContext, type AcContext } from "./autocomplete";

export interface AcTarget {
  ctx: AcContext;
  /** Caret to splice at, read live from the textarea: the selection end, so
   * a "[[" wrapped around still-selected text completes over that text. */
  caret: number;
  /** The textarea's live text, the snapshot `caret` and `ctx` describe. */
  text: string;
}

export interface AutocompleteController {
  /** The open completion context; null when the popup is closed. */
  ctx: AcContext | null;
  /** Index of the highlighted row. */
  selected: number;
  setSelected: Dispatch<SetStateAction<number>>;
  /** Record a text edit: re-detect the context at the new caret and reset the
   * highlight. Returns the new context — callers need it to decide whether
   * the draft flush is held (holdsDraftFlush). */
  onEdit: (text: string, caret: number) => AcContext | null;
  close: () => void;
  /** What a pick would act on right now, or null when nothing is open or the
   * caret has moved off the token since the last input event. Closes a stale
   * popup as it goes, so this is the single gate every action path (keydown,
   * mouse pick, click) goes through — a null result means "the popup is not
   * live, let the key/click do its normal thing".
   *
   * Safe to call from keydown and click, but NOT from keyup: both editors
   * place the caret after a key-edit in a requestAnimationFrame (an auto-
   * paired "[[" is the common case), and keyup always lands inside that
   * window, where the DOM caret still sits at the end of the freshly
   * committed value and every context would look stale. */
  resolve: (el: HTMLTextAreaElement | null) => AcTarget | null;
}

export function useAutocomplete(): AutocompleteController {
  const [ctx, setCtx] = useState<AcContext | null>(null);
  const [selected, setSelected] = useState(0);

  const close = () => {
    setCtx(null);
    setSelected(0);
  };

  return {
    ctx,
    selected,
    setSelected,
    close,
    onEdit: (text, caret) => {
      const next = detectAutocomplete(text, caret);
      setCtx(next);
      setSelected(0);
      return next;
    },
    resolve: (el) => {
      if (ctx === null || el === null) return null;
      // The selection END is the caret the query ends at. When "[[" wraps a
      // selection the inner text stays selected (pkm-wxwp); the start of
      // that selection sits right after the "[[" and would read as an empty
      // query, wrongly closing a live popup. Same offset when collapsed.
      const caret = el.selectionEnd;
      const live = liveAcContext(ctx, el.value, caret);
      if (live === null) {
        close();
        return null;
      }
      return { ctx: live, caret, text: el.value };
    },
  };
}
