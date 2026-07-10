// pattern: Functional Core
// Finds the [[page reference]] span (if any) whose bracket-inclusive range
// contains the caret, so Ctrl-O (see EditableBlockTree.tsx) can navigate to
// that page. Bracket-matching mirrors grammar/refs.ts's scanBrackets, but
// tracks start/end offsets instead of only the title.

interface RefSpan {
  start: number; // index of the first "["
  end: number;   // index just past the final "]"
  title: string;
}

/** Balanced [[...]] scan with positions; nested links are included so a
 * caret in an inner ref can win over its outer one. */
function scanRefSpans(text: string, offset: number): RefSpan[] {
  const out: RefSpan[] = [];
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
        out.push({ start: offset + i, end: offset + j, title: inner });
        out.push(...scanRefSpans(inner, offset + i + 2));
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
}

/** Title of the [[...]] span containing `caret` (inclusive of the brackets
 * themselves), or null if the caret isn't inside a closed, non-empty ref.
 * When refs are nested, the innermost one wins. */
export function refTitleAtCaret(text: string, caret: number): string | null {
  const spans = scanRefSpans(text, 0)
    .filter((s) => s.title !== "" && caret >= s.start && caret <= s.end);
  if (spans.length === 0) return null;
  const innermost = spans.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
  return innermost.title;
}
