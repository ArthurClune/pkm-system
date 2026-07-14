// pattern: Functional Core
// Flip the presented block-start {{TODO}}/{{DONE}} marker (including after an
// exact `> ` quote prefix), echoing back whichever bracket variant the text
// used. Mirrors tokenize.ts TODO_PREFIX, which
// (documented leniency) accepts each bracket side independently; Roam only
// emits {{[[TODO]]}} / {{TODO}}, but toggling must never corrupt text.
const TODO_RE = /^\{\{(\[\[)?(TODO|DONE)(\]\])?\}\}/;

export function toggleTodo(text: string): string | null {
  const quotePrefix = text.startsWith("> ") ? "> " : "";
  const content = quotePrefix ? text.slice(quotePrefix.length) : text;
  const m = TODO_RE.exec(content);
  if (!m) return null;
  const flipped = m[2] === "TODO" ? "DONE" : "TODO";
  return quotePrefix + `{{${m[1] ?? ""}${flipped}${m[3] ?? ""}}}`
    + content.slice(m[0].length);
}
