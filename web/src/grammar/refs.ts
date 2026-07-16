// pattern: Functional Core
// Mirrors server/src/pkm/refs.py EXACTLY; pinned by
// shared/fixtures/ref_grammar.json (both parsers must pass it). All
// scanning is delegated to the shared grammar scanner (scan.ts); this
// adapter only regroups tokens into refs.py's output shape and order:
// attribute first, then page refs (outer before inner), then hashtags.

import { scanGrammar } from "./scan";

export type RefKind = "link" | "tag" | "attribute";

export interface Ref {
  title: string;
  kind: RefKind;
}

export interface ParsedRefs {
  refs: Ref[];
  block_refs: string[];
  embeds: number;
}

export function extractRefs(text: string): ParsedRefs {
  const { tokens } = scanGrammar(text);
  const attributes: Ref[] = [];
  const pageRefs: Ref[] = [];
  const hashtags: Ref[] = [];
  const block_refs: string[] = [];
  let embeds = 0;
  for (const t of tokens) {
    if (t.kind === "attribute") attributes.push({ title: t.title, kind: "attribute" });
    else if (t.kind === "page-ref") pageRefs.push({ title: t.title, kind: t.tag ? "tag" : "link" });
    else if (t.kind === "hashtag") hashtags.push({ title: t.title, kind: "tag" });
    else if (t.kind === "block-ref") block_refs.push(t.uid);
    else if (t.kind === "embed") embeds += 1;
  }
  const seen = new Set<string>();
  const refs = [...attributes, ...pageRefs, ...hashtags].filter((r) => {
    const key = `${r.kind}\x00${r.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { refs, block_refs, embeds };
}
