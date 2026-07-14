// pattern: Functional Core
// Presentation-only derivations from stored block data. These helpers never
// rewrite source text: focused editing must always expose the exact value that
// will be persisted.

/** Return the display content for an exact-prefix quote, or null for ordinary text. */
export function quoteContent(text: string): string | null {
  return text.startsWith("> ") ? text.slice(2) : null;
}
