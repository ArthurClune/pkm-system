// pattern: Functional Core
// Decision logic for the outline block textarea's auto-grow (see
// useBlockDraft.ts): whether a keystroke needs the expensive "reset to auto,
// then measure" round trip, and whether a freshly measured height differs
// enough from the last applied one to be worth writing. Kept pure and
// DOM-free so the keystroke cost question (how many forced layouts does
// typing X do) is answerable without a browser (pkm-youp).
//
// Why a reset is sometimes required: a textarea's `scrollHeight` is clamped
// below by the element's OWN current box height -- once the box has grown to
// fit a tall paste, `scrollHeight` cannot report a smaller natural content
// height on a later keystroke until the box is reset to `auto` and
// remeasured. Growth never needs a reset: `scrollHeight` already reports the
// larger natural height against the current (smaller or equal) box. So the
// reset is only worth paying for when the content may have gotten shorter.

/** Whether `nextText` may render shorter than `prevText` -- the one case
 * where skipping the `height: auto` reset would leave the textarea stuck at
 * its old (too tall) height. Newline count is what actually drives wrapped
 * line count, not raw length: "cat" -> "catches" is height-preserving
 * growth, but "a\nb" -> "ab" is a same-or-longer string that still lost a
 * line. Length is kept as a cheap first check for the far more common case
 * (a plain deletion) so the newline count rarely needs computing. */
export function mayHaveShrunk(prevText: string, nextText: string): boolean {
  if (nextText.length < prevText.length) return true;
  return countNewlines(nextText) < countNewlines(prevText);
}

function countNewlines(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return count;
}

/** Whether a freshly measured height is worth writing to the element.
 * `lastAppliedPx` is null before the first measurement, which always counts
 * as a change so the textarea gets sized at least once. Equal to the last
 * applied height means the write -- and the layout it would invalidate --
 * is pure waste. */
export function heightChanged(
  measuredPx: number, lastAppliedPx: number | null,
): boolean {
  return measuredPx !== lastAppliedPx;
}
