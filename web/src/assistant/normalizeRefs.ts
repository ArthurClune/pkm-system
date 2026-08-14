// pattern: Functional Core
// pkm-wx86: MCP tool output shows blocks with trailing ^uid markers and
// some models (GLM) copy the caret verbatim into citations, emitting
// ((^uid)). The shared ref grammar deliberately rejects that form, so the
// assistant render path strips the caret before tokenizing instead of
// widening the grammar. Runs on raw message text, before inline-code
// spans are identified — a ((^uid)) inside backticks is rewritten too.

const CARET_BLOCK_REF_RE = /\(\(\^([a-zA-Z0-9_-]{6,})\)\)/g;

export function stripCaretBlockRefs(text: string): string {
  return text.replace(CARET_BLOCK_REF_RE, "(($1))");
}
