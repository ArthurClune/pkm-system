// pattern: Functional Core
// The longest a page title may be: MAX_PAGE_TITLE_CHARS code points of its
// fold (normalizeRefTitle), measured on the title as sent. The server
// refuses a title past it (refs.title_length_over), as a page title and as
// a ref in block text; the editor asks first, so the user sees a notice
// instead of a refused batch. shared/fixtures/title_length.json pins the
// cap, the measure and the refusal wording equal to the server's.
import { extractRefs } from "./refs";
import { normalizeRefTitle } from "./scan";
import { codePointLength } from "./textLimits";

export const MAX_PAGE_TITLE_CHARS = 1_000;

export const TITLE_LENGTH_NOTICE =
  "A page title can't be longer than 1,000 characters.";

/** The length of `text`'s fold when that is over the cap, else null. The
 * fold never lengthens, and a code point is at least one UTF-16 unit, so a
 * text no longer than the cap in units skips the fold. */
export function titleLengthOver(text: string): number | null {
  if (text.length <= MAX_PAGE_TITLE_CHARS) return null;
  const measured = codePointLength(normalizeRefTitle(text));
  return measured > MAX_PAGE_TITLE_CHARS ? measured : null;
}

/** The refusal's wording, the same string the server's carries. */
export function describeTitleLength(measured: number): string {
  return `title of ${measured} characters is over the limit of `
    + `${MAX_PAGE_TITLE_CHARS}`;
}

/** The measure of the first ref in `text`, in extractRefs order, whose
 * title is over the cap, else null. A ref's title is part of the text, so
 * a text no longer than the cap holds none and is not scanned. */
export function linkedTitleLengthOver(text: string): number | null {
  if (text.length <= MAX_PAGE_TITLE_CHARS) return null;
  for (const ref of extractRefs(text).refs) {
    const measured = titleLengthOver(ref.title);
    if (measured !== null) return measured;
  }
  return null;
}
