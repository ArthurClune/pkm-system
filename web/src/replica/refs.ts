// pattern: Functional Core
// TS port of server refs.py `extract` — needed so offline-written
// [[links]]/#tags/attributes produce local refs rows before sync (spec
// section 3). Parity-pinned by shared/fixtures/refs_parity.json and (via
// its own test) shared/fixtures/ref_grammar.json. Extraction is delegated
// to grammar/refs.ts, which shares the one grammar scanner with the
// renderer; this adapter only renames block_refs to the replica's
// camelCase shape and drops the embed count it does not store.

import type { BlockUid } from "../api/brands";
import { extractRefs as extractParsedRefs, type RefKind } from "../grammar/refs";

export interface ExtractedRef {
  title: string;
  kind: RefKind;
}

export interface ExtractedRefs {
  refs: ExtractedRef[];
  blockRefs: BlockUid[];
}

export function extractRefs(text: string): ExtractedRefs {
  const { refs, block_refs } = extractParsedRefs(text);
  return { refs, blockRefs: block_refs };
}
