// pattern: Functional Core
// Flip the block-start {{TODO}}/{{DONE}} marker, echoing back whichever
// bracket variant the text used. Mirrors tokenize.ts TODO_PREFIX, which
// (documented leniency) accepts each bracket side independently; Roam only
// emits {{[[TODO]]}} / {{TODO}}, but toggling must never corrupt text.
const TODO_RE = /^\{\{(\[\[)?(TODO|DONE)(\]\])?\}\}/;

export function toggleTodo(text: string): string | null {
  const m = TODO_RE.exec(text);
  if (!m) return null;
  const flipped = m[2] === "TODO" ? "DONE" : "TODO";
  return `{{${m[1] ?? ""}${flipped}${m[3] ?? ""}}}` + text.slice(m[0].length);
}
