// pattern: Functional Core
// Tokenizes Roam-flavoured block text into typed segments for rendering.
// Reference/TODO/code recognition comes from the shared grammar scanner
// (scan.ts, which follows server/src/pkm/refs.py semantics); this file owns
// only the rendering-side grammar the scanner does not model: markdown
// links and images, bare-URL autolinking, emphasis, {{query}} blocks and
// line breaks. Ref *extraction* lives in refs.ts on the same scanner.

import { scanGrammar, type GrammarToken } from "./scan";

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

const QUERY_PREFIX = /^\{\{(?:\[\[)?query(?:\]\])?:\s*/;

const EMPHASIS: [string, EmphasisKind][] = [
  ["**", "bold"], ["__", "italic"], ["~~", "strike"], ["^^", "highlight"],
];

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

/** The InlineSegment for a scanner token, or null for kinds the inline
 * renderer does not consume (embed prefixes render as plain text; todo and
 * code-fence tokens are handled at the block level). */
function inlineSegment(text: string, tok: GrammarToken): InlineSegment | null {
  switch (tok.kind) {
    case "inline-code":
      return { kind: "inline-code", code: text.slice(tok.start + 1, tok.end - 1) };
    case "page-ref":
      // raw slice, not tok.title: the rendered title keeps code verbatim
      return { kind: "page-ref",
               title: text.slice(tok.content.start, tok.content.end), tag: tok.tag };
    case "hashtag":
      return { kind: "page-ref", title: tok.title, tag: true };
    case "block-ref":
      return { kind: "block-ref", uid: tok.uid };
    case "attribute":
      return { kind: "attribute", name: tok.title };
    default:
      return null;
  }
}

/** Render [from, to) as inline segments, consuming scanner tokens that lie
 * fully inside the range. `from` is a chunk boundary for autolinking (the
 * old per-chunk scan treated chunk starts like whitespace). */
function tokenizeInline(
  text: string, byStart: ReadonlyMap<number, GrammarToken>,
  from: number, to: number,
): InlineSegment[] {
  const out: InlineSegment[] = [];
  let buf = "";
  const flushText = () => {
    if (buf) { out.push({ kind: "text", text: buf }); buf = ""; }
  };
  let i = from;
  while (i < to) {
    const ch = text[i];
    if (ch === "\n") {
      flushText();
      out.push({ kind: "linebreak" });
      i += 1;
      continue;
    }
    const tok = byStart.get(i);
    if (tok && tok.end <= to) {
      const seg = inlineSegment(text, tok);
      if (seg) {
        flushText();
        out.push(seg);
        i = tok.end;
        continue;
      }
    }
    if (ch === "!" && text.startsWith("![", i)) {
      const link = scanMarkdownLink(text, i + 1);
      if (link && link.end <= to) {
        flushText();
        out.push({ kind: "image", alt: link.text, src: link.href });
        i = link.end;
        continue;
      }
    }
    if (ch === "[" && !text.startsWith("[[", i)) {
      const link = scanMarkdownLink(text, i);
      if (link && link.end <= to) {
        flushText();
        out.push({ kind: "link", text: link.text, href: link.href });
        i = link.end;
        continue;
      }
    }
    if (ch === "h" && (i === from || /[\s([{]/.test(text[i - 1]))) {
      const m = /^https?:\/\/\S+/.exec(text.slice(i, to));
      if (m) {
        // trailing punctuation is prose, not URL: "see https://x.org/a."
        const url = m[0].replace(/[.,;:!?'")\]}>]+$/, "");
        if (!/^https?:\/\/$/.test(url)) {
          flushText();
          out.push({ kind: "link", text: url, href: url });
          i += url.length;
          continue;
        }
      }
    }
    let matchedEmphasis = false;
    for (const [marker, kind] of EMPHASIS) {
      if (!text.startsWith(marker, i)) continue;
      const close = text.indexOf(marker, i + 2);
      if (close === -1 || close === i + 2 || close + 2 > to) continue;
      const inner = text.slice(i + 2, close);
      if (inner.includes("\n")) continue;
      flushText();
      out.push({ kind, children: tokenizeInline(text, byStart, i + 2, close) });
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
  const { tokens } = scanGrammar(text);
  // Tokens are sorted outer-before-inner, so on a shared start the wider
  // token wins the map slot (e.g. an attribute over a hashtag in "#x:: y").
  const byStart = new Map<number, GrammarToken>();
  for (const t of tokens) if (!byStart.has(t.start)) byStart.set(t.start, t);

  const out: BlockSegment[] = [];
  const todo = tokens.find((t) => t.kind === "todo");
  const start = todo ? todo.suffixEnd : 0;
  if (todo) out.push({ kind: "todo", done: todo.state === "DONE" });

  // Block-level pass: closed fences and {{query}} blocks split the text into
  // inline chunks (queries are scanned locally and win over inline code at
  // the block level, as before).
  let i = start;
  let chunkStart = start;
  const flush = (end: number) => {
    if (end > chunkStart) out.push(...tokenizeInline(text, byStart, chunkStart, end));
  };
  while (i < text.length) {
    const tok = byStart.get(i);
    if (tok?.kind === "code-fence") {
      flush(i);
      out.push(parseFence(text.slice(i + 3, tok.end - 3)));
      i = tok.end;
      chunkStart = i;
      continue;
    }
    if (text.startsWith("{{", i)) {
      const q = scanQuery(text, i);
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
  flush(text.length);
  return out;
}
