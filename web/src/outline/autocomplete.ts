// pattern: Functional Core
// Detect an open [[ / # completion context at the cursor and splice a picked
// title back into the text. Tag charset mirrors tokenize.ts (#[A-Za-z0-9_/-]);
// anything else gets the #[[Long Title]] form.
export interface AcContext {
  kind: "ref" | "tag";
  start: number; // index of the query's first char (after the trigger)
  query: string;
}

const PLAIN_TAG_RE = /^[A-Za-z0-9_/-]+$/;

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
  return null;
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
