// pattern: Functional Core
// Mirrors server/src/pkm/refs.py EXACTLY; pinned by
// shared/fixtures/ref_grammar.json (both parsers must pass it).

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

const CODE_FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const ATTRIBUTE = /^\s*([^\[\]{}:\n]+?)::/;
// [\p{L}\p{N}_] mirrors Python's unicode-aware \w closely enough for titles.
const HASHTAG = /(?<=^|[\s(])#([\p{L}\p{N}_./\-]+)/gu;
const BLOCK_REF = /\(\(([a-zA-Z0-9_-]{6,})\)\)/g;
const EMBED = /\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]/g;

function stripCode(text: string): string {
  const blank = (m: string) => " ".repeat(m.length); // keep offsets/line starts
  return text.replace(CODE_FENCE, blank).replace(INLINE_CODE, blank);
}

/** Balanced [[...]] scan. Nested links yield outer then inner titles.
 * Returns [title, isTag] pairs; isTag when written as #[[...]]. */
function scanBrackets(text: string, nested: boolean): [string, boolean][] {
  const out: [string, boolean][] = [];
  let i = 0;
  const n = text.length;
  while (i < n - 1) {
    if (text[i] === "[" && text[i + 1] === "[") {
      let depth = 1;
      let j = i + 2;
      while (j < n - 1 && depth > 0) {
        const pair = text.slice(j, j + 2);
        if (pair === "[[") { depth += 1; j += 2; }
        else if (pair === "]]") { depth -= 1; j += 2; }
        else { j += 1; }
      }
      if (depth === 0) {
        const inner = text.slice(i + 2, j - 2);
        const isTag = !nested && i > 0 && text[i - 1] === "#";
        out.push([inner, isTag]);
        out.push(...scanBrackets(inner, true));
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

export function extractRefs(text: string): ParsedRefs {
  const clean = stripCode(text);
  const refs: Ref[] = [];
  const attr = ATTRIBUTE.exec(clean);
  if (attr) refs.push({ title: attr[1].trim(), kind: "attribute" });
  for (const [title, isTag] of scanBrackets(clean, false)) {
    refs.push({ title, kind: isTag ? "tag" : "link" });
  }
  for (const m of clean.matchAll(HASHTAG)) {
    refs.push({ title: m[1], kind: "tag" });
  }
  const seen = new Set<string>();
  const deduped = refs.filter((r) => {
    const key = `${r.kind}\x00${r.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    refs: deduped,
    block_refs: [...clean.matchAll(BLOCK_REF)].map((m) => m[1]),
    embeds: [...clean.matchAll(EMBED)].length,
  };
}
