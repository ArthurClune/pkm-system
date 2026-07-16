// pattern: Functional Core
// The single shared scanner for reference and TODO grammar. Every consumer
// (tokenize.ts rendering, grammar/refs.ts + replica/refs.ts extraction,
// outline/refAtCaret.ts caret lookup, grammar/todo.ts toggling, and
// outline/slashCommands.ts via the todo helpers) derives its behavior from
// this token stream instead of keeping a private scan.
//
// Canonical rules (mirroring server/src/pkm/refs.py, pinned by
// shared/fixtures/ref_grammar.json):
// - Code is opaque: fences and same-line inline code are recorded first and
//   blanked (space-for-char) before any reference/TODO recognition, so a #
//   right after code sits at a "whitespace" boundary, exactly like refs.py.
// - Spans are UTF-16 code-unit offsets, half-open, source ordered with an
//   outer reference before its children.
// - Malformed/unclosed syntax ([[x, ((abc)), lone ```) stays plain text.
// - Bracket pairs are matched iteratively with an explicit stack — never by
//   recursive rescanning — so 10k-deep nesting cannot overflow the JS stack.
// - A ref is a tag when a # directly precedes its [[ and no MATCHED pair
//   encloses it (a ref inside an unclosed [[ is effectively top-level).
// - The TODO marker is only recognized at offset 0 and keeps each lenient
//   bracket side ({{[[TODO}} etc.) so togglers can echo the spelling back.

export interface Span {
  start: number;
  end: number;
}

export type GrammarToken =
  | ({ kind: "page-ref"; content: Span; title: string; tag: boolean;
       depth: number; parentStart: number | null } & Span)
  | ({ kind: "block-ref"; uid: string } & Span)
  | ({ kind: "hashtag"; title: string } & Span)
  | ({ kind: "attribute"; title: string } & Span)
  | ({ kind: "embed" } & Span)
  | ({ kind: "todo"; state: "TODO" | "DONE";
       openBrackets: boolean; closeBrackets: boolean;
       suffixEnd: number } & Span)
  | ({ kind: "inline-code" | "code-fence" } & Span);

const TODO_RE = /^\{\{(\[\[)?(TODO|DONE)(\]\])?\}\}/;
const ATTRIBUTE_RE = /^\s*([^\[\]{}:\n]+?)::/;
const BLOCK_REF_RE = /\(\(([a-zA-Z0-9_-]{6,})\)\)/y;
const EMBED_RE = /\{\{\s*(?:\[\[)?embed(?:\]\])?\s*[:}]/y;
// [\p{L}\p{N}_] mirrors Python's unicode-aware \w closely enough for titles.
const TAG_CHARS_RE = /[\p{L}\p{N}_./\-]+/uy;
const TAG_BOUNDARY_RE = /[\s(]/;

/** Left-to-right opaque-code pass: closed fences win over inline code, and
 * inline code must close before the next newline. Returns the code tokens
 * plus the input with every code range blanked to same-length spaces. */
function scanCode(text: string): { codeTokens: GrammarToken[]; clean: string } {
  const codeTokens: GrammarToken[] = [];
  const parts: string[] = [];
  let i = 0;
  let last = 0;
  const blank = (kind: "inline-code" | "code-fence", end: number) => {
    codeTokens.push({ kind, start: i, end });
    parts.push(text.slice(last, i), " ".repeat(end - i));
    last = end;
    i = end;
  };
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const close = text.indexOf("```", i + 3);
      if (close !== -1) { blank("code-fence", close + 3); continue; }
    }
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (close !== -1 && (nl === -1 || close < nl)) {
        blank("inline-code", close + 1);
        continue;
      }
    }
    i += 1;
  }
  parts.push(text.slice(last));
  return { codeTokens, clean: parts.join("") };
}

interface BracketPair {
  open: number;      // index of the first "["
  close: number;     // index just past the final "]"
  tagCandidate: boolean;
}

/** Match [[...]] pairs iteratively over blanked text with an explicit stack;
 * unmatched opens/closes are dropped (they stay plain text). */
function matchBracketPairs(clean: string): BracketPair[] {
  const stack: Omit<BracketPair, "close">[] = [];
  const pairs: BracketPair[] = [];
  const n = clean.length;
  let i = 0;
  while (i < n) {
    const ch = clean[i];
    if (ch === "[" && clean[i + 1] === "[") {
      stack.push({ open: i, tagCandidate: i > 0 && clean[i - 1] === "#" });
      i += 2;
    } else if (ch === "]" && clean[i + 1] === "]" && stack.length > 0) {
      pairs.push({ ...stack.pop()!, close: i + 2 });
      i += 2;
    } else {
      i += 1;
    }
  }
  return pairs;
}

/** Convert matched pairs into page-ref tokens: pre-order (outer before
 * children), depth/parent counted over MATCHED ancestors only, and a tag's
 * span extended to include its leading #. */
function pageRefTokens(clean: string, pairs: BracketPair[]): GrammarToken[] {
  pairs.sort((a, b) => a.open - b.open);
  const tokens: GrammarToken[] = [];
  const ancestors: { start: number; close: number }[] = [];
  for (const p of pairs) {
    while (ancestors.length > 0 && p.open >= ancestors[ancestors.length - 1].close) {
      ancestors.pop();
    }
    const depth = ancestors.length;
    const tag = depth === 0 && p.tagCandidate;
    const start = tag ? p.open - 1 : p.open;
    tokens.push({
      kind: "page-ref", start, end: p.close,
      content: { start: p.open + 2, end: p.close - 2 },
      title: clean.slice(p.open + 2, p.close - 2),
      tag, depth,
      parentStart: depth === 0 ? null : ancestors[ancestors.length - 1].start,
    });
    ancestors.push({ start, close: p.close });
  }
  return tokens;
}

/** Single pass over the blanked text for hashtags, block refs and embed
 * prefixes (bracket pairs are collected in the same walk). */
function scanFlatTokens(clean: string): GrammarToken[] {
  const tokens: GrammarToken[] = [];
  const n = clean.length;
  let i = 0;
  while (i < n) {
    const ch = clean[i];
    if (ch === "(" && clean[i + 1] === "(") {
      BLOCK_REF_RE.lastIndex = i;
      const m = BLOCK_REF_RE.exec(clean);
      if (m) {
        tokens.push({ kind: "block-ref", uid: m[1], start: i, end: i + m[0].length });
        i += m[0].length;
        continue;
      }
    } else if (ch === "{" && clean[i + 1] === "{") {
      EMBED_RE.lastIndex = i;
      const m = EMBED_RE.exec(clean);
      if (m) {
        tokens.push({ kind: "embed", start: i, end: i + m[0].length });
        i += 2; // keep scanning inside: {{[[embed]]: ...}} also holds a ref
        continue;
      }
    } else if (ch === "#" && (i === 0 || TAG_BOUNDARY_RE.test(clean[i - 1]))) {
      TAG_CHARS_RE.lastIndex = i + 1;
      const m = TAG_CHARS_RE.exec(clean);
      if (m) {
        tokens.push({ kind: "hashtag", title: m[0], start: i, end: i + 1 + m[0].length });
        i += 1 + m[0].length;
        continue;
      }
    }
    i += 1;
  }
  return tokens;
}

function validate(tokens: GrammarToken[], length: number): void {
  for (const t of tokens) {
    const spanOk = t.start >= 0 && t.start <= t.end && t.end <= length;
    const contentOk = t.kind !== "page-ref"
      || (t.content.start >= t.start && t.content.start <= t.content.end
          && t.content.end <= t.end);
    const suffixOk = t.kind !== "todo"
      || (t.suffixEnd >= t.end && t.suffixEnd <= length);
    if (!spanOk || !contentOk || !suffixOk) {
      throw new Error(`scanGrammar: invalid span for ${t.kind} token`);
    }
  }
}

export function scanGrammar(text: string): { tokens: readonly GrammarToken[] } {
  const { codeTokens, clean } = scanCode(text);
  const tokens: GrammarToken[] = [...codeTokens];

  const todo = TODO_RE.exec(text); // marker chars can never be code
  if (todo) {
    const end = todo[0].length;
    tokens.push({
      kind: "todo", start: 0, end,
      state: todo[2] === "DONE" ? "DONE" : "TODO",
      openBrackets: todo[1] !== undefined,
      closeBrackets: todo[3] !== undefined,
      suffixEnd: end < text.length && /\s/.test(text[end]) ? end + 1 : end,
    });
  }

  const attr = ATTRIBUTE_RE.exec(clean);
  if (attr) {
    const end = attr[0].length;
    tokens.push({ kind: "attribute", title: attr[1].trim(),
                  start: end - 2 - attr[1].length, end });
  }

  tokens.push(...scanFlatTokens(clean));
  tokens.push(...pageRefTokens(clean, matchBracketPairs(clean)));

  // Source order; on a shared start the wider (outer) token comes first.
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  validate(tokens, text.length);
  return { tokens };
}
