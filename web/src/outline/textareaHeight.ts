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
// remeasured, and a clamped measurement is indistinguishable from an
// unchanged one to `heightChanged` below -- it can only compare what it
// measured, and a clamped read never differs from what's already applied.
// So skipping the reset is safe only for the one case where the box is
// guaranteed not to need to shrink: a strictly longer replacement that lost
// no newlines. An append or insert can only add wrapped lines, never remove
// one. Everything else resets, including an equal-length or shorter
// replacement -- character width varies (a run of "w"s wraps sooner than
// the same count of "i"s), so even same-length text can re-wrap narrower.

/** Whether `nextText` might need the full `height: auto` remeasure instead
 * of the cheap grown-only path. Newline count is what actually drives
 * wrapped line count, not raw length: "one line" -> "one line\nand another"
 * is growth even though it gained a newline, but "a\nb\nc" -> "a b c d" is a
 * longer string that still lost two. Length is checked first because it's
 * the cheap majority case (any non-growth resets, full stop) and the
 * newline count only needs computing for the strictly-longer case. */
export function mayHaveShrunk(prevText: string, nextText: string): boolean {
  if (nextText.length <= prevText.length) return true;
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
