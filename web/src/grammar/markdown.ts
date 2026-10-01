// pattern: Functional Core
import type { Span } from "./scan";

export interface MarkdownSpan extends Span {
  kind: "link" | "image";
  label: Span;
  destination: Span;
}

// The `)` closing a link destination that starts at `start`. Parens inside
// it nest, as in CommonMark, so a filename like "Programme (Public).pdf"
// stays whole. When they do not balance before the end of the line, the
// first `)` closes, as it always has for text like `[x](a (b)`.
function scanDestinationClose(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length && text[i] !== "\n"; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return text.indexOf(")", start);
}

export function scanMarkdownLinkAt(
  text: string,
  start: number,
): MarkdownSpan | null {
  const image = text[start] === "!";
  const open = image ? start + 1 : start;
  if (text[open] !== "[" || text.startsWith("[[", open)) return null;

  let depth = 1;
  let cursor = open + 1;
  while (cursor < text.length && depth > 0) {
    if (text[cursor] === "\n") return null;
    if (text[cursor] === "[") depth += 1;
    else if (text[cursor] === "]") depth -= 1;
    cursor += 1;
  }
  if (depth !== 0 || text[cursor] !== "(") return null;

  const close = scanDestinationClose(text, cursor + 1);
  if (close === -1 || text.slice(cursor + 1, close).includes("\n")) return null;
  return {
    kind: image ? "image" : "link",
    start,
    end: close + 1,
    label: { start: open + 1, end: cursor - 1 },
    destination: { start: cursor + 1, end: close },
  };
}

export function scanMarkdownLinks(text: string): readonly MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const candidate = text[cursor] === "!" && text[cursor + 1] === "["
      ? scanMarkdownLinkAt(text, cursor)
      : text[cursor] === "[" && !text.startsWith("[[", cursor)
        ? scanMarkdownLinkAt(text, cursor)
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
