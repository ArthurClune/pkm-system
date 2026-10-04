// pattern: Functional Core
// Shared title canonicalization for replica boundaries. Control whitespace is
// always normalized by the reference-title rule; migration activation adds
// removal of boundary U+0020 only, preserving NBSP and internal spaces.

import type { NormalizedTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import { normalizeRefTitle } from "../grammar/scan";
import { extractRefs } from "./refs";

export type TitleSyntaxReason = "forbidden_syntax";

export function titleSyntaxReason(title: string): TitleSyntaxReason | null {
  const normalized = normalizeRefTitle(title);
  return normalized.includes("#") || normalized.includes("[[")
    || normalized.includes("]]")
    ? "forbidden_syntax"
    : null;
}

export interface OpTitleViolation {
  opIndex: number;
  source: "page_title" | "reference";
  title: string;
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

/** Every title a local apply of `ops` may make a page for: the page a
 * create, move or create_page names, and each [[link]], #tag or attribute
 * in a create's or update's text. Raw, as the ops carry them. */
export function opPageTitles(ops: readonly BlockOp[]): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if ((op.op === "create" || op.op === "move" || op.op === "create_page")
        && op.page_title != null) {
      out.push(op.page_title);
    }
    if (op.op === "create" || op.op === "update_text") {
      for (const ref of extractRefs(op.text).refs) out.push(ref.title);
    }
  }
  return out;
}

/** Normalized, not canonical: only the caller knows whether
 * `plainSpaceActive` is this replica's live flag. A CanonicalTitle comes from
 * meta.ts's `canonicalTitle` / `titleReader`, which read the flag. */
export function canonicalizeTitle(title: string,
                                  plainSpaceActive: boolean): NormalizedTitle {
  const normalized = normalizeRefTitle(title);
  return plainSpaceActive
    ? normalized.replace(/^ +| +$/g, "") as NormalizedTitle
    : normalized;
}
