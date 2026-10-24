// pattern: Functional Core
// The single shared scanner for reference and TODO grammar. Every consumer
// (tokenize.ts rendering, grammar/refs.ts + replica/refs.ts extraction,
// outline/refAtCaret.ts caret lookup, grammar/todo.ts toggling,
// outline/slashCommands.ts via the todo helpers, and grammar/textLimits.ts
// via linkNestingDepth) derives its behavior from this token stream, or the
// bracket pairs beneath it, instead of keeping a private scan.
//
// Canonical rules (mirroring server/src/pkm/refs.py, pinned by
// shared/fixtures/ref_grammar.json):
// - Code is opaque: fences and same-line inline code are recorded first and
//   blanked (space-for-char) before any reference/TODO recognition, so a #
//   right after code sits at a "whitespace" boundary, exactly like refs.py.
// - Spans are UTF-16 code-unit offsets, half-open, source ordered with an
//   outer reference before its children.
// - A link, tag link or attribute whose title, as written, holds a backtick
//   is no ref (mirrors refs.py holds_backtick): the code pass has blanked a
//   closed code span, so the check reads the original text. A dropped link's
//   brackets are plain text and its children are promoted.
// - Malformed/unclosed syntax ([[x, ((abc)), lone ```) stays plain text.
// - Bracket pairs are matched iteratively with an explicit stack — never by
//   recursive rescanning — so 10k-deep nesting cannot overflow the JS stack.
// - A ref is a tag when a # directly precedes its [[ and no MATCHED pair
//   encloses it (a ref inside an unclosed [[ is effectively top-level).
// - The TODO marker is only recognized at offset 0 and keeps each lenient
//   bracket side ({{[[TODO}} etc.) so togglers can echo the spelling back.

import type { BlockUid, NormalizedTitle } from "../api/brands";

export interface Span {
  start: number;
  end: number;
}

export type GrammarToken =
  | ({ kind: "page-ref"; content: Span; title: NormalizedTitle; tag: boolean;
       depth: number; parentStart: number | null } & Span)
  | ({ kind: "block-ref"; uid: BlockUid } & Span)
  | ({ kind: "hashtag"; title: NormalizedTitle } & Span)
  | ({ kind: "attribute"; title: NormalizedTitle } & Span)
  | ({ kind: "embed" } & Span)
  | ({ kind: "todo"; state: "TODO" | "DONE";
       openBrackets: boolean; closeBrackets: boolean;
       suffixEnd: number } & Span)
  | ({ kind: "inline-code" | "code-fence" } & Span);

// Mirrors refs.py normalize_title. Titles are normalized where they are
// born, so no page holds control whitespace: a multi-line [[link]] resolves
// to the one-line title — for extraction, for the rendered link's href, and
// for Ctrl-O navigation alike. Deliberately narrow: a title with no control
// whitespace is returned unchanged, so "Two  Spaces" keeps its double space.
const CONTROL_WS_RE = /[\t\n\r\f\v]/;
const WS_RUN_RE = /[ \t\n\r\f\v]+/g;

export function normalizeRefTitle(text: string): NormalizedTitle {
  if (!CONTROL_WS_RE.test(text)) return text as NormalizedTitle;
  return stripLikePython(text.replace(WS_RUN_RE, " ")) as NormalizedTitle;
}

// The whitespace of Python's str.strip() and its re `\s`, which refs.py
// trims titles with and anchors hashtags and embeds on. JS's trim() and
// `\s` are a different set: they also take U+FEFF and leave out
// U+001C-U+001F and U+0085, so a title edged with one of those would name
// another page here than on the server.
const PY_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029"
  + "\\u202f\\u205f\\u3000";
const PY_SPACE_RE = new RegExp(`[${PY_SPACE}]`);
const isPythonSpace = (ch: string): boolean => PY_SPACE_RE.test(ch);

/** `text.lstrip()` as refs.py reads it: a scan, not a regex, so a long
 * blank text costs one pass. */
export function stripStartLikePython(text: string): string {
  let i = 0;
  while (i < text.length && isPythonSpace(text[i])) i += 1;
  return text.slice(i);
}

/** `text.strip()` as refs.py reads it. */
export function stripLikePython(text: string): string {
  let end = text.length;
  while (end > 0 && isPythonSpace(text[end - 1])) end -= 1;
  return stripStartLikePython(text.slice(0, end));
}

const UNREACHABLE_SEGMENTS = new Set(["", ".", ".."]);

/** Mirrors refs.py has_unreachable_segment: does the title, edge-stripped
 * of U+0020 once normalized, hold a `.`, `..` or empty `/` segment? Such a
 * title has no URL. A blank title is not one. */
export function hasUnreachableSegment(text: string): boolean {
  const canonical = normalizeRefTitle(text).replace(/^ +| +$/g, "");
  if (stripLikePython(canonical).length === 0) return false;
  return canonical.split("/").some((seg) => UNREACHABLE_SEGMENTS.has(seg));
}

/** Mirrors refs.py is_blank_title: nothing but whitespace once normalized.
 * Every blank-title decision (a ref that names no page, a page create the
 * replica refuses or files as Untitled) goes through this one predicate. */
export function isBlankRefTitle(text: string): boolean {
  return stripLikePython(normalizeRefTitle(text)).length === 0;
}

/** Does a ref token's title name a page? False for a blank title and for
 * one with no URL. The ref extractor and the inline renderer both ask this,
 * so a token is a link exactly when it is a ref. */
export function isRefTitle(text: string): boolean {
  return !isBlankRefTitle(text) && !hasUnreachableSegment(text);
}

const TODO_RE = /^\{\{(\[\[)?(TODO|DONE)(\]\])?\}\}/;
// No leading \s* in the pattern: it overlaps the lazy name class and is
// quadratic to fail on an all-blank text (a block that is one big fence).
// scanGrammar skips the leading whitespace itself, as refs.py does.
const ATTRIBUTE_RE = /([^\[\]{}:\n]+?)::/y;
// A uid's shape, matching server/src/pkm/refs.py's BLOCK_REF_TOKEN (itself
// built from contracts/ops.py's UID_RE): a token outside {6,32} can never
// have been minted. replica/localApi/router.ts's UID_RE and
// assistant/normalizeRefs.ts's caret-ref pattern import this rather than
// keeping their own copy, so the three web definitions can't drift apart.
export const UID_TOKEN = "[a-zA-Z0-9_-]{6,32}";
const BLOCK_REF_RE = new RegExp(`\\(\\((${UID_TOKEN})\\)\\)`, "y");
const EMBED_RE = new RegExp(
  `\\{\\{[${PY_SPACE}]*(?:\\[\\[)?embed(?:\\]\\])?[${PY_SPACE}]*[:}]`, "y");
// [\p{L}\p{N}_] mirrors Python's unicode-aware \w closely enough for titles.
const TAG_CHARS_RE = /[\p{L}\p{N}_./\-]+/uy;
const TAG_BOUNDARY_RE = new RegExp(`[${PY_SPACE}(]`);
// ASCII on purpose, the same class as refs.py's _WORD_CHAR: a Unicode
// class follows each runtime's Unicode table, which differs between Python
// and a browser, and a fence closer tests one UTF-16 unit, so a non-ASCII
// letter after ``` used to close a fence on one side and open one on the
// other, and the two disagreed on the refs and `[[` depth of the block.
const WORD_CHAR_RE = /[A-Za-z0-9_]/;
const INLINE_CODE_RE = /`[^`\n]*`/y;

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
  // A closer search that finds nothing from one opener finds nothing from
  // any later opener (its window is a suffix of the first), so one failure
  // retires the fence rule. Without it, many ```lang openers and no closer
  // rescan the whole text each.
  let fencePossible = true;
  while (i < text.length) {
    if (fencePossible && text.startsWith("```", i)) {
      // A ``` run followed by an ASCII word character is a fence *opener*
      // with an info string (```css, ```mermaid), never a closer — without
      // this skip, an outer fence pairs with the first inner example's
      // opener, fence parity flips, and hex colours in the exposed code mint
      // pages named "0277bd" (mirrors _fence_end in refs.py).
      let close = text.indexOf("```", i + 3);
      while (close !== -1 && close + 3 < text.length
             && WORD_CHAR_RE.test(text[close + 3])) {
        close = text.indexOf("```", close + 1);
      }
      if (close !== -1) { blank("code-fence", close + 3); continue; }
      fencePossible = false;
    }
    if (text[i] === "`") {
      // Sticky, so a miss stops at the next backtick or newline instead of
      // scanning to a newline that may be far away.
      INLINE_CODE_RE.lastIndex = i;
      const m = INLINE_CODE_RE.exec(text);
      if (m !== null) {
        blank("inline-code", i + m[0].length);
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

/** Mirrors refs.py backtick_positions: where the text holds a backtick,
 * ascending. Built once per scan so a deep nest stays linear. */
function backtickPositions(text: string): number[] {
  const ticks: number[] = [];
  for (let i = text.indexOf("`"); i !== -1; i = text.indexOf("`", i + 1)) {
    ticks.push(i);
  }
  return ticks;
}

/** Mirrors refs.py holds_backtick: a backtick in `[start, end)`. */
function holdsBacktick(ticks: number[], start: number, end: number): boolean {
  let lo = 0;
  let hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ticks[mid] < start) lo = mid + 1;
    else hi = mid;
  }
  return lo < ticks.length && ticks[lo] < end;
}

/** Convert matched pairs, sorted by open, into page-ref tokens: pre-order
 * (outer before children), depth/parent counted over MATCHED ancestors
 * only, and a tag's span extended to include its leading #. */
function pageRefTokens(clean: string, pairs: readonly BracketPair[],
): GrammarToken[] {
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
      // the content span still covers the source text verbatim; only the
      // resolved title is normalized (see normalizeRefTitle)
      title: normalizeRefTitle(clean.slice(p.open + 2, p.close - 2)),
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
        // A full match of BLOCK_REF_RE's capture group is UID_TOKEN-shaped
        // by construction.
        tokens.push({ kind: "block-ref", uid: m[1] as BlockUid,
                      start: i, end: i + m[0].length });
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
        // TAG_CHARS_RE admits no whitespace, so a hashtag's title is
        // normalized by construction.
        tokens.push({ kind: "hashtag", title: m[0] as NormalizedTitle,
                      start: i, end: i + 1 + m[0].length });
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

interface BracketScan {
  codeTokens: GrammarToken[];
  clean: string;      // the text with every code range blanked
  ticks: number[];    // backtickPositions of the text as written
  pairs: BracketPair[];
}

/** The code pass and the `[[...]]` runs over what it leaves, as refs.py
 * _bracket_pairs reports them: a pair whose title as written holds a
 * backtick is dropped before nesting is counted, and the rest are sorted by
 * open. scanGrammar builds its tokens from this, and linkNestingDepth
 * measures it, so the two cannot disagree on which runs exist. */
function scanBrackets(text: string): BracketScan {
  const { codeTokens, clean } = scanCode(text);
  const ticks = backtickPositions(text);
  const pairs = matchBracketPairs(clean)
    .filter((p) => !holdsBacktick(ticks, p.open + 2, p.close - 2))
    .sort((a, b) => a.open - b.open);
  return { codeTokens, clean, ticks, pairs };
}

/** How deep `text`'s `[[...]]` runs nest: one more than the deepest
 * page-ref token scanGrammar reports, 0 when it has none. A walk over the
 * sorted pairs with a stack of enclosing closes, so a nest hundreds of
 * thousands deep is measured without recursion and without building tokens.
 * Mirrors refs.py link_nesting_depth, pinned equal by
 * shared/fixtures/text_limits_parity.json. */
export function linkNestingDepth(text: string): number {
  const closes: number[] = []; // close offsets of the pairs enclosing this one
  let deepest = 0;
  for (const p of scanBrackets(text).pairs) {
    while (closes.length > 0 && p.open >= closes[closes.length - 1]) {
      closes.pop();
    }
    closes.push(p.close);
    deepest = Math.max(deepest, closes.length);
  }
  return deepest;
}

export function scanGrammar(text: string): { tokens: readonly GrammarToken[] } {
  const { codeTokens, clean, ticks, pairs } = scanBrackets(text);
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

  ATTRIBUTE_RE.lastIndex = clean.length - stripStartLikePython(clean).length;
  const attr = ATTRIBUTE_RE.exec(clean);
  if (attr) {
    const end = ATTRIBUTE_RE.lastIndex;
    const start = end - 2 - attr[1].length;
    if (!holdsBacktick(ticks, start, end - 2)) {
      tokens.push({ kind: "attribute", title: normalizeRefTitle(stripLikePython(attr[1])),
                    start, end });
    }
  }

  tokens.push(...scanFlatTokens(clean));
  tokens.push(...pageRefTokens(clean, pairs));

  // Source order; on a shared start the wider (outer) token comes first.
  tokens.sort((a, b) => a.start - b.start || b.end - a.end);
  validate(tokens, text.length);
  return { tokens };
}
