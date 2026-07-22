// pattern: Functional Core
import type { Span } from "./scan";

export interface MarkdownSpan extends Span {
  kind: "link" | "image";
  label: Span;
  destination: Span;
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

  const close = text.indexOf(")", cursor + 1);
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
