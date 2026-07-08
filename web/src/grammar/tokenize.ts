// pattern: Functional Core
// Tokenizes Roam-flavoured block text into typed segments for rendering.
// Ref *extraction* lives in refs.ts; both follow server/src/pkm/refs.py
// semantics (code first, attribute at block start, tag charset, uid shape).

export type EmphasisKind = "bold" | "italic" | "strike" | "highlight";

export type InlineSegment =
  | { kind: "text"; text: string }
  | { kind: "linebreak" }
  | { kind: "inline-code"; code: string }
  | { kind: "page-ref"; title: string; tag: boolean }
  | { kind: "attribute"; name: string }
  | { kind: "block-ref"; uid: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "link"; text: string; href: string }
  | { kind: EmphasisKind; children: InlineSegment[] };

export type BlockSegment =
  | InlineSegment
  | { kind: "todo"; done: boolean }
  | { kind: "code-block"; lang: string | null; code: string }
  | { kind: "query"; expr: string };

const TODO_PREFIX = /^\{\{(?:\[\[)?(TODO|DONE)(?:\]\])?\}\}\s?/;
const QUERY_PREFIX = /^\{\{(?:\[\[)?query(?:\]\])?:\s*/;
const ATTRIBUTE = /^\s*([^\[\]{}:\n]+?)::/;
const BLOCK_REF_AT = /^\(\(([a-zA-Z0-9_-]{6,})\)\)/;
const TAG_CHARS = /^[\p{L}\p{N}_./\-]+/u;

const EMPHASIS: [string, EmphasisKind][] = [
  ["**", "bold"], ["__", "italic"], ["~~", "strike"], ["^^", "highlight"],
];

/** From i pointing at "[[": index just past the closing "]]", or -1. */
function scanDoubleBrackets(text: string, i: number): number {
  let depth = 1;
  let j = i + 2;
  while (j < text.length - 1 && depth > 0) {
    const pair = text.slice(j, j + 2);
    if (pair === "[[") { depth += 1; j += 2; }
    else if (pair === "]]") { depth -= 1; j += 2; }
    else { j += 1; }
  }
  return depth === 0 ? j : -1;
}

/** From i pointing at "{{[[query]]:" / "{{query:": [expr, end] via a
 * balanced-brace scan (the expr itself contains braces), or null. */
function scanQuery(text: string, i: number): [string, number] | null {
  const m = QUERY_PREFIX.exec(text.slice(i));
  if (!m) return null;
  let depth = 2; // the two braces of "{{"
  let j = i + 2;
  while (j < text.length && depth > 0) {
    if (text[j] === "{") depth += 1;
    else if (text[j] === "}") depth -= 1;
    j += 1;
  }
  if (depth !== 0) return null;
  return [text.slice(i + m[0].length, j - 2).trim(), j];
}

/** From i pointing at "[": {text, href, end} for [text](href), or null. */
function scanMarkdownLink(
  text: string, i: number,
): { text: string; href: string; end: number } | null {
  let depth = 1;
  let j = i + 1;
  while (j < text.length && depth > 0) {
    if (text[j] === "\n") return null;
    if (text[j] === "[") depth += 1;
    else if (text[j] === "]") depth -= 1;
    j += 1;
  }
  if (depth !== 0 || text[j] !== "(") return null;
  const close = text.indexOf(")", j + 1);
  if (close === -1 || text.slice(j + 1, close).includes("\n")) return null;
  return { text: text.slice(i + 1, j - 1), href: text.slice(j + 1, close), end: close + 1 };
}

function parseFence(body: string): BlockSegment {
  const nl = body.indexOf("\n");
  if (nl === -1) return { kind: "code-block", lang: null, code: body };
  const lang = body.slice(0, nl).trim();
  return {
    kind: "code-block",
    lang: lang || null,
    code: body.slice(nl + 1).replace(/\n$/, ""),
  };
}

function tokenizeInline(text: string, blockStart: boolean): InlineSegment[] {
  const out: InlineSegment[] = [];
  let buf = "";
  const flushText = () => {
    if (buf) { out.push({ kind: "text", text: buf }); buf = ""; }
  };
  let i = 0;
  if (blockStart) {
    const m = ATTRIBUTE.exec(text);
    if (m) {
      out.push({ kind: "attribute", name: m[1].trim() });
      i = m[0].length;
    }
  }
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n") {
      flushText();
      out.push({ kind: "linebreak" });
      i += 1;
      continue;
    }
    if (ch === "`") {
      const close = text.indexOf("`", i + 1);
      const nl = text.indexOf("\n", i + 1);
      if (close !== -1 && (nl === -1 || close < nl)) {
        flushText();
        out.push({ kind: "inline-code", code: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (ch === "!" && text.startsWith("![", i)) {
      const link = scanMarkdownLink(text, i + 1);
      if (link) {
        flushText();
        out.push({ kind: "image", alt: link.text, src: link.href });
        i = link.end;
        continue;
      }
    }
    if (ch === "[" && text.startsWith("[[", i)) {
      const end = scanDoubleBrackets(text, i);
      if (end !== -1) {
        flushText();
        out.push({ kind: "page-ref", title: text.slice(i + 2, end - 2), tag: false });
        i = end;
        continue;
      }
    }
    if (ch === "[" && !text.startsWith("[[", i)) {
      const link = scanMarkdownLink(text, i);
      if (link) {
        flushText();
        out.push({ kind: "link", text: link.text, href: link.href });
        i = link.end;
        continue;
      }
    }
    if (ch === "#") {
      if (text.startsWith("#[[", i)) {
        const end = scanDoubleBrackets(text, i + 1);
        if (end !== -1) {
          flushText();
          out.push({ kind: "page-ref", title: text.slice(i + 3, end - 2), tag: true });
          i = end;
          continue;
        }
      }
      const prev = i === 0 ? " " : text[i - 1];
      const m = TAG_CHARS.exec(text.slice(i + 1));
      if (m && /[\s(]/.test(prev)) {
        flushText();
        out.push({ kind: "page-ref", title: m[0], tag: true });
        i += 1 + m[0].length;
        continue;
      }
    }
    if (ch === "(" && text.startsWith("((", i)) {
      const m = BLOCK_REF_AT.exec(text.slice(i));
      if (m) {
        flushText();
        out.push({ kind: "block-ref", uid: m[1] });
        i += m[0].length;
        continue;
      }
    }
    let matchedEmphasis = false;
    for (const [marker, kind] of EMPHASIS) {
      if (!text.startsWith(marker, i)) continue;
      const close = text.indexOf(marker, i + 2);
      if (close === -1 || close === i + 2) continue;
      const inner = text.slice(i + 2, close);
      if (inner.includes("\n")) continue;
      flushText();
      out.push({ kind, children: tokenizeInline(inner, false) });
      i = close + 2;
      matchedEmphasis = true;
      break;
    }
    if (matchedEmphasis) continue;
    buf += ch;
    i += 1;
  }
  flushText();
  return out;
}

export function tokenizeBlock(text: string): BlockSegment[] {
  const out: BlockSegment[] = [];
  let rest = text;
  const todo = TODO_PREFIX.exec(rest);
  if (todo) {
    out.push({ kind: "todo", done: todo[1] === "DONE" });
    rest = rest.slice(todo[0].length);
  }
  const first = !todo; // attribute can only start an un-prefixed block
  let i = 0;
  let chunkStart = 0;
  const flush = (end: number) => {
    if (end > chunkStart) {
      out.push(...tokenizeInline(rest.slice(chunkStart, end), first && chunkStart === 0));
    }
  };
  while (i < rest.length) {
    if (rest.startsWith("```", i)) {
      const close = rest.indexOf("```", i + 3);
      if (close !== -1) {
        flush(i);
        out.push(parseFence(rest.slice(i + 3, close)));
        i = close + 3;
        chunkStart = i;
        continue;
      }
    }
    if (rest.startsWith("{{", i)) {
      const q = scanQuery(rest, i);
      if (q) {
        flush(i);
        out.push({ kind: "query", expr: q[0] });
        i = q[1];
        chunkStart = i;
        continue;
      }
    }
    i += 1;
  }
  flush(rest.length);
  return out;
}
