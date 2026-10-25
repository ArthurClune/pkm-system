// pattern: Functional Core
// Copy for the delete-page dialogs: pure strings from the server's preview.
import type { RawTitle } from "../api/brands";
import type { components } from "../api/types";

export type DeletePreview = components["schemas"]["DeletePreview"];
export type DeleteBlocker = components["schemas"]["DeleteBlockerModel"];

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function plainDeleteMessage(title: RawTitle): string {
  return `Delete "${title}"? This cannot be undone.`;
}

export function deleteConfirmMessage(title: RawTitle,
                                     p: DeletePreview): string {
  let message = plainDeleteMessage(title);
  if (p.links > 0) {
    message += ` ${plural(p.links, "link")} on ${plural(p.link_pages, "page")}`
      + " will become plain text.";
  }
  if (p.block_refs > 0) {
    message += ` ${plural(p.block_refs, "block reference")} on `
      + `${plural(p.block_ref_pages, "page")} will be replaced with a copy of `
      + "the text they point to.";
  }
  return message;
}

export function blockedHeading(title: RawTitle): string {
  return `Can't delete "${title}"`;
}

export const BLOCKED_LEAD = "Change these blocks first:";

/** A blocker's text as the dialog shows it: the server sends an excerpt
 * and the whole text's length in code points, and a cut excerpt says so
 * rather than passing for the whole text. */
export function blockerExcerpt(
  b: Pick<DeleteBlocker, "excerpt" | "text_length">,
): string {
  const shown = [...b.excerpt].length;
  if (shown >= b.text_length) return b.excerpt;
  return `${b.excerpt}… (${b.text_length.toLocaleString("en-US")} characters)`;
}

export function blockerReasonLabel(reason: DeleteBlocker["reason"]): string {
  switch (reason) {
    case "query":
      return "a query names this page";
    case "used_as_attribute":
      return "this page is used as an attribute";
    case "attribute":
      return "unlinking would make this an attribute";
    case "residual":
      return "unlinking would still leave a link to this page";
    case "limit":
      return "the copied text would put this block over a size or nesting limit";
  }
}
