// pattern: Functional Core
// FTS5 snippets arrive with literal <mark>…</mark> markers. Split on the
// exact tags and return runs; the renderer emits real <mark> elements.
// Server text is NEVER injected as HTML.

const OPEN = "<mark>";
const CLOSE = "</mark>";

export function parseSnippet(snippet: string): { text: string; mark: boolean }[] {
  const out: { text: string; mark: boolean }[] = [];
  const parts = snippet.split(OPEN);
  const head = parts[0];
  if (head) out.push({ text: head, mark: false });
  for (const part of parts.slice(1)) {
    const end = part.indexOf(CLOSE);
    if (end === -1) {
      if (part) out.push({ text: part, mark: false }); // unclosed: literal
      continue;
    }
    out.push({ text: part.slice(0, end), mark: true });
    const rest = part.slice(end + CLOSE.length);
    if (rest) out.push({ text: rest, mark: false });
  }
  return out;
}
