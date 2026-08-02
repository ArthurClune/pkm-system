// pattern: Functional Core
// Shared title canonicalization for replica boundaries. Control whitespace is
// always normalized by the reference-title rule; migration activation adds
// removal of boundary U+0020 only, preserving NBSP and internal spaces.

import { normalizeRefTitle } from "../grammar/scan";

export function canonicalizeTitle(title: string,
                                  plainSpaceActive: boolean): string {
  const normalized = normalizeRefTitle(title);
  return plainSpaceActive ? normalized.replace(/^ +| +$/g, "") : normalized;
}
