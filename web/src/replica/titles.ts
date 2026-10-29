// pattern: Functional Core
// Shared title canonicalization for replica boundaries. Whitespace runs
// (NBSP and the other listed characters included) always fold to one U+0020
// by the reference-title rule; migration activation adds removal of boundary
// U+0020 from a title the fold left unchanged.

import type { CanonicalTitle, NormalizedTitle, RawTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { hasUnreachableSegment, normalizeRefTitle, trimSpaces } from "../grammar/scan";
import { describeTitleLength, TITLE_LENGTH_NOTICE,
         titleLengthOver } from "../grammar/titleLength";

export { isBlankRefTitle as isBlankTitle } from "../grammar/scan";
import { extractRefs } from "./refs";

// The general mint of RawTitle: text no check has run on.
export function asRawTitle(text: string): RawTitle {
  return text as RawTitle;
}

export type TitleSyntaxReason = "forbidden_syntax";

/** Mirrors refs.py title_syntax_reason: every rule judges the title
 * edge-stripped of U+0020, whatever the plain-space flag. A trailing `[`
 * is refused because unlinking `[[a[]]` leaves `a[`, which joins a
 * following `[a[]]` into a fresh link. */
export function titleSyntaxReason(text: string): TitleSyntaxReason | null {
  const canonical = canonicalizeTitle(text, true);
  return canonical.includes("#") || canonical.includes("[[")
    || canonical.includes("]]") || canonical.endsWith("]")
    || canonical.endsWith("[")
    || canonical.includes("`") || hasUnreachableSegment(canonical)
    ? "forbidden_syntax"
    : null;
}

export type TitleRefusal = TitleSyntaxReason | "too_long";

/** Mirrors refs.py title_refusal: length first, so a refusal never names a
 * title millions of characters long and the syntax rules never read one. */
export function titleRefusal(text: string): TitleRefusal | null {
  return titleLengthOver(text) !== null ? "too_long" : titleSyntaxReason(text);
}

export interface OpTitleViolation {
  opIndex: number;
  source: "page_title" | "reference";
  title: RawTitle;
  reason: TitleRefusal;
}

/** The refusal's wording. A title over the cap is named by its length, in
 * the server's words (ops_core.describe_op_title_violation). */
export function describeOpTitleViolation(violation: OpTitleViolation): string {
  const measured = violation.reason === "too_long"
    ? titleLengthOver(violation.title) : null;
  if (measured !== null) {
    return `${violation.source} ${describeTitleLength(measured)}`;
  }
  return `unsupported ${violation.source} title syntax: `
    + JSON.stringify(violation.title);
}

export const TITLE_SYNTAX_NOTICE =
  "A page title can't contain #, [[, ]], a backtick, or end in [ or ].";

/** The edit notice for a refused title, or null when nothing is refused. */
export function titleRefusalNotice(reason: TitleRefusal | null): string | null {
  if (reason === null) return null;
  return reason === "too_long" ? TITLE_LENGTH_NOTICE : TITLE_SYNTAX_NOTICE;
}

/** The refusal of the first ref in `text`, in extractRefs order, else null.
 * The server judges every ref a text holds, one the block already held
 * before a rule included, so this does too. Callers pass text already
 * inside the text limits, which keep the scan bounded. */
export function linkedTitleRefusal(text: string): TitleRefusal | null {
  if (!text.includes("[[")) return null;
  for (const ref of extractRefs(text).refs) {
    const reason = titleRefusal(ref.title);
    if (reason !== null) return reason;
  }
  return null;
}

/** The first title an op names that may not be a page title, in the
 * server's order (ops_core.find_op_title_violation). update_text's
 * page_title is a conflict-header hint and is never judged. */
export function findOpTitleViolation(
  ops: readonly BlockOp[],
): OpTitleViolation | null {
  for (const [opIndex, op] of ops.entries()) {
    const pageTitle = op.op === "create" || op.op === "create_page"
      ? op.page_title
      : op.op === "move" ? op.page_title : null;
    if (pageTitle != null) {
      const reason = titleRefusal(pageTitle);
      if (reason !== null) {
        return { opIndex, source: "page_title", title: pageTitle, reason };
      }
    }
    if (op.op === "create" || op.op === "update_text") {
      for (const ref of extractRefs(op.text).refs) {
        const reason = titleRefusal(ref.title);
        if (reason !== null) {
          return { opIndex, source: "reference", title: ref.title, reason };
        }
      }
    }
  }
  return null;
}

/** Normalized, not canonical: only the caller knows whether
 * `plainSpaceActive` is this replica's live flag. A CanonicalTitle comes from
 * `titleReaderFor` below, which meta.ts's `titleReader` calls with the
 * worker's flag and sync/titleCanonicalization.ts with its mirror of it. */
export function canonicalizeTitle(text: string,
                                  plainSpaceActive: boolean): NormalizedTitle {
  const normalized = normalizeRefTitle(text);
  return plainSpaceActive
    ? trimSpaces(normalized) as NormalizedTitle
    : normalized;
}

/** `canonicalTitle` for an operation that canonicalises several titles: the
 * flag is read once, not once per title (sync_meta.title_reader). The flag
 * it read rides along, so a caller that also branches on it needs no second
 * read. */
export type TitleReader = ((text: string) => CanonicalTitle) &
  { readonly plainSpaceActive: boolean };

/** The one pure constructor of a TitleReader, so of CanonicalTitle from text:
 * replica/meta.ts reads the flag from the database, and the main thread's
 * mirror (sync/titleCanonicalization.ts) from its copy. */
export function titleReaderFor(plainSpaceActive: boolean): TitleReader {
  return Object.assign(
    (text: string) => canonicalizeTitle(text, plainSpaceActive) as CanonicalTitle,
    { plainSpaceActive });
}
