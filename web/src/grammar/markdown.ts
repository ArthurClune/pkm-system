// pattern: Functional Core
import type { Span } from "./scan";

export interface MarkdownSpan extends Span {
  kind: "link" | "image";
  label: Span;
  destination: Span;
}

/** Where each `[` and `(` of `text[from, to)` closes, by offset from
 * `from`, or -1. A `[` closes at its matching `]` on the same line: the
 * label of a link, brackets nesting. A `(` closes at its matching `)` on
 * the same line, so a destination like "Programme (Public).pdf" stays
 * whole; when its parens do not balance before the end of the line, at
 * the first `)` after it on that line, as it always has for text like
 * `[x](a (b)`. One pass forward pairs each line's brackets and parens
 * with a stack, one pass back finds the fallback `)`, so probing every `[`
 * of a long line costs the line once rather than once per `[`. */
function closesOf(text: string, from: number, to: number): Int32Array {
  const closes = new Int32Array(to - from).fill(-1);
  const brackets: number[] = [];
  const parens: number[] = [];
  for (let i = from; i < to; i += 1) {
    const ch = text[i];
    if (ch === "\n") {
      brackets.length = 0;
      parens.length = 0;
    } else if (ch === "[") brackets.push(i);
    else if (ch === "(") parens.push(i);
    else if (ch === "]" && brackets.length > 0) closes[brackets.pop()! - from] = i;
    else if (ch === ")" && parens.length > 0) closes[parens.pop()! - from] = i;
  }
  let nextClose = -1; // the first `)` after i on i's line
  for (let i = to - 1; i >= from; i -= 1) {
    const ch = text[i];
    if (ch === "\n") nextClose = -1;
    else if (ch === ")") nextClose = i;
    else if (ch === "(" && closes[i - from] === -1) closes[i - from] = nextClose;
  }
  return closes;
}

/** Does a link or image open at `start`? The offset of its `[` if so. */
function linkOpen(text: string, start: number): number | null {
  const open = text[start] === "!" ? start + 1 : start;
  if (text[open] !== "[" || text.startsWith("[[", open)) return null;
  return open;
}

/** The link or image whose `[` is at `open`, given where `[` and `(`
 * close (closeAt, from closesOf). */
function linkSpan(text: string, start: number, open: number,
                  closeAt: (i: number) => number): MarkdownSpan | null {
  const labelClose = closeAt(open);
  if (labelClose === -1 || text[labelClose + 1] !== "(") return null;
  const close = closeAt(labelClose + 1);
  if (close === -1) return null;
  return {
    kind: open === start ? "link" : "image",
    start,
    end: close + 1,
    label: { start: open + 1, end: labelClose },
    destination: { start: labelClose + 2, end: close },
  };
}

/** The link or image at `start`, pairing only `start`'s line: one probe
 * costs that line. To probe many starts in one text, markdownLinkScanner
 * pairs it once. */
export function scanMarkdownLinkAt(
  text: string,
  start: number,
): MarkdownSpan | null {
  const open = linkOpen(text, start);
  if (open === null) return null;
  const lineStart = text.lastIndexOf("\n", open) + 1;
  const newline = text.indexOf("\n", open);
  const closes = closesOf(text, lineStart, newline === -1 ? text.length : newline);
  return linkSpan(text, start, open, (i) => closes[i - lineStart]);
}

/** scanMarkdownLinkAt for many starts in one text: the first probe that
 * reaches a `[` pairs the whole text once, so a line of lone `[` costs its
 * length, not its square. */
export function markdownLinkScanner(
  text: string,
): (start: number) => MarkdownSpan | null {
  let closes: Int32Array | null = null;
  return (start) => {
    const open = linkOpen(text, start);
    if (open === null) return null;
    const paired = closes ??= closesOf(text, 0, text.length);
    return linkSpan(text, start, open, (i) => paired[i]);
  };
}

export function scanMarkdownLinks(text: string): readonly MarkdownSpan[] {
  const linkAt = markdownLinkScanner(text);
  const spans: MarkdownSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const candidate = text[cursor] === "!" && text[cursor + 1] === "["
      ? linkAt(cursor)
      : text[cursor] === "[" && !text.startsWith("[[", cursor)
        ? linkAt(cursor)
        : null;
    if (candidate) {
      spans.push(candidate);
      cursor = candidate.end;
    } else {
      cursor += 1;
    }
  }
  return spans;
}
