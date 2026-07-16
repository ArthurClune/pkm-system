// pattern: Functional Core
// Shared TODO-marker helpers on top of the grammar scanner (scan.ts).
// toggleTodo flips the presented block-start {{TODO}}/{{DONE}} marker
// (including after an exact `> ` quote prefix), echoing back whichever
// bracket variant the text used: the scanner accepts each bracket side
// independently (documented leniency; Roam only emits {{[[TODO]]}} /
// {{TODO}}) and toggling must never corrupt text. hasTodoMarker lets
// slashCommands avoid double-prefixing an already-TODO block.

import { scanGrammar, type GrammarToken } from "./scan";

type TodoToken = Extract<GrammarToken, { kind: "todo" }>;

function todoMarker(text: string): TodoToken | undefined {
  return scanGrammar(text).tokens
    .find((t): t is TodoToken => t.kind === "todo");
}

/** True when the block text itself starts with a {{TODO}}/{{DONE}} marker
 * (no quote-prefix handling — mirrors the tokenizer's block-start rule). */
export function hasTodoMarker(text: string): boolean {
  return todoMarker(text) !== undefined;
}

export function toggleTodo(text: string): string | null {
  const quotePrefix = text.startsWith("> ") ? "> " : "";
  const content = quotePrefix ? text.slice(quotePrefix.length) : text;
  const marker = todoMarker(content);
  if (!marker) return null;
  const flipped = marker.state === "TODO" ? "DONE" : "TODO";
  return quotePrefix
    + `{{${marker.openBrackets ? "[[" : ""}${flipped}${marker.closeBrackets ? "]]" : ""}}}`
    + content.slice(marker.end);
}

/** Cycles a block's task state: plain -> TODO -> DONE -> plain. TODO->DONE
 * reuses toggleTodo (bracket variant + quote prefix preserved as usual);
 * DONE->plain strips the marker and one following space; plain->TODO
 * prepends `{{TODO}} ` after the quote prefix, mirroring toggleTodo's
 * prefix handling. */
export function cycleTodo(text: string): string {
  const quotePrefix = text.startsWith("> ") ? "> " : "";
  const content = quotePrefix ? text.slice(quotePrefix.length) : text;
  const marker = todoMarker(content);
  if (!marker) return `${quotePrefix}{{TODO}} ${content}`;
  if (marker.state === "TODO") return toggleTodo(text)!;
  const rest = content.slice(marker.end);
  return quotePrefix + (rest.startsWith(" ") ? rest.slice(1) : rest);
}
