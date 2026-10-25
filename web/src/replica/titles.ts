// pattern: Functional Core
// Shared title canonicalization for replica boundaries. Whitespace runs
// (NBSP and the other listed characters included) always fold to one U+0020
// by the reference-title rule; migration activation adds removal of boundary
// U+0020 from a title the fold left unchanged.

import type { CanonicalTitle, NormalizedTitle, RawTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { hasUnreachableSegment, normalizeRefTitle, trimSpaces } from "../grammar/scan";

export { isBlankRefTitle as isBlankTitle } from "../grammar/scan";
import { extractRefs } from "./refs";

// The general mint of RawTitle: text no check has run on.
export function asRawTitle(text: string): RawTitle {
  return text as RawTitle;
}

export type TitleSyntaxReason = "forbidden_syntax";

/** Mirrors refs.py title_syntax_reason: every rule judges the title
 * edge-stripped of U+0020, whatever the plain-space flag. */
export function titleSyntaxReason(text: string): TitleSyntaxReason | null {
  const canonical = canonicalizeTitle(text, true);
  return canonical.includes("#") || canonical.includes("[[")
    || canonical.includes("]]") || canonical.endsWith("]")
    || canonical.includes("`") || hasUnreachableSegment(canonical)
    ? "forbidden_syntax"
    : null;
}

export interface OpTitleViolation {
  opIndex: number;
  source: "page_title" | "reference";
  title: RawTitle;
  reason: TitleSyntaxReason;
}

export function findOpTitleViolation(
  ops: readonly BlockOp[],
): OpTitleViolation | null {
  for (const [opIndex, op] of ops.entries()) {
    const pageTitle = op.op === "create" || op.op === "create_page"
      ? op.page_title
      : op.op === "move" ? op.page_title : null;
    if (pageTitle != null) {
      const reason = titleSyntaxReason(pageTitle);
      if (reason !== null) {
        return { opIndex, source: "page_title", title: pageTitle, reason };
      }
    }
    if (op.op === "create" || op.op === "update_text") {
      for (const ref of extractRefs(op.text).refs) {
        const reason = titleSyntaxReason(ref.title);
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
