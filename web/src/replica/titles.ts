// pattern: Functional Core
// Shared title canonicalization for replica boundaries. Control whitespace is
// always normalized by the reference-title rule; migration activation adds
// removal of boundary U+0020 only, preserving NBSP and internal spaces.

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

export function canonicalizeTitle(title: string,
                                  plainSpaceActive: boolean): string {
  const normalized = normalizeRefTitle(title);
  return plainSpaceActive ? normalized.replace(/^ +| +$/g, "") : normalized;
}
