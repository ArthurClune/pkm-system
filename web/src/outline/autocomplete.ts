// pattern: Functional Core
// Detect an open [[ / # / (slash) completion context at the cursor and splice
// a picked title (or slash command, see slashCommands.ts) back into the text.
// Tag charset mirrors tokenize.ts (#[A-Za-z0-9_/-]); anything else gets the
// #[[Long Title]] form.
export interface AcContext {
  kind: "ref" | "tag" | "command";
  start: number; // index of the query's first char (after the trigger)
  query: string;
}

const PLAIN_TAG_RE = /^[A-Za-z0-9_/-]+$/;
// Must start with a letter (so a bare "/2020" in prose stays quiet) but may
// be followed by digits or hyphens (so "/h1" and "/query-and" keep the menu
// open); any other punctuation or whitespace after the "/" closes the command
// menu (this also keeps it quiet inside URLs and path-like text, see below).
// A hyphenated non-command like "/on-site" leaves the context open but
// matches nothing, which renders no popup and swallows no keys.
const SLASH_QUERY_RE = /^([A-Za-z][A-Za-z0-9-]*)?$/;

export function detectAutocomplete(text: string,
                                   cursor: number): AcContext | null {
  const before = text.slice(0, cursor);
  const open = before.lastIndexOf("[[");
  if (open !== -1) {
    const between = before.slice(open + 2);
    if (!between.includes("]]") && !between.includes("\n")) {
      return { kind: "ref", start: open + 2, query: between };
    }
  }
  const hash = before.lastIndexOf("#");
  if (hash !== -1 && (hash === 0 || /\s/.test(before[hash - 1]))) {
    const between = before.slice(hash + 1);
    if (between !== "" && PLAIN_TAG_RE.test(between)) {
      return { kind: "tag", start: hash + 1, query: between };
    }
  }
  // Same start-of-block-or-after-whitespace rule as # above: a "/" glued to
  // the previous character (as in a URL's "://" or a "path/to/x") never
  // triggers. Unlike "#", a bare "/" DOES trigger — that's how the menu opens.
  const slash = before.lastIndexOf("/");
  if (slash !== -1 && (slash === 0 || /\s/.test(before[slash - 1]))) {
    const between = before.slice(slash + 1);
    if (SLASH_QUERY_RE.test(between)) {
      return { kind: "command", start: slash + 1, query: between };
    }
  }
  return null;
}

/** The completion context to act on, re-derived from the text and caret read
 * live off the textarea at the moment of a keypress or pick. `stored` is what
 * the last input event detected; a click or a selection-only caret move fires
 * no input event, so it can describe a token the caret has since left —
 * acting on it would splice the completion at the old offset, or swallow an
 * Enter the user meant as a newline (pkm-noow). Null when nothing is open, or
 * when the live caret no longer implies exactly the stored context: a
 * narrowed query is stale too, because the rows on screen were fetched for
 * the longer one and completing would strand its tail. */
export function liveAcContext(stored: AcContext | null, text: string,
                              caret: number): AcContext | null {
  if (stored === null) return null;
  const live = detectAutocomplete(text, caret);
  if (live === null) return null;
  return live.kind === stored.kind && live.start === stored.start
      && live.query === stored.query ? live : null;
}

/** Whether the debounced draft autosave should be deferred: the caret is
 * mid-token in a page-creating context ([[ ref or #tag), so committing now
 * would materialise the half-typed title as a page — the server creates a
 * page for every ref it indexes (pkm-xlah). Slash commands create nothing,
 * so they never hold. Explicit commits (blur, structural edits) still flush. */
export function holdsDraftFlush(ctx: AcContext | null): boolean {
  return ctx !== null && (ctx.kind === "ref" || ctx.kind === "tag");
}

export function applyCompletion(text: string, cursor: number, ctx: AcContext,
                                title: string): { text: string; cursor: number } {
  const after = text.slice(cursor);
  if (ctx.kind === "ref") {
    const rest = after.startsWith("]]") ? after.slice(2) : after;
    const head = text.slice(0, ctx.start) + title + "]]";
    return { text: head + rest, cursor: head.length };
  }
  const inserted = PLAIN_TAG_RE.test(title) ? title : `[[${title}]]`;
  const head = text.slice(0, ctx.start) + inserted;
  return { text: head + after, cursor: head.length };
}
