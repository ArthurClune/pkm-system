// pattern: Functional Core
// Finds the [[page reference]] span (if any) whose bracket-inclusive range
// contains the caret, so Ctrl-O (see EditableBlockTree.tsx) can navigate to
// that page. Spans come from the shared grammar scanner (grammar/scan.ts),
// so refs inside code are opaque and never match.

import { scanGrammar } from "../grammar/scan";

/** Title of the [[...]] span containing `caret` (inclusive of the brackets
 * themselves but not a tag's leading #), or null if the caret isn't inside
 * a closed, non-empty ref. When refs are nested, the innermost one wins. */
export function refTitleAtCaret(text: string, caret: number): string | null {
  let best: { size: number; title: string } | null = null;
  for (const t of scanGrammar(text).tokens) {
    if (t.kind !== "page-ref") continue;
    const start = t.tag ? t.start + 1 : t.start; // caret on the # is outside
    const title = text.slice(t.content.start, t.content.end);
    if (title === "" || caret < start || caret > t.end) continue;
    const size = t.end - start;
    if (best === null || size < best.size) best = { size, title };
  }
  return best === null ? null : best.title;
}
