// pattern: Functional Core
// The ` | name: value` options after a {{query: ...}} or {{table ...}}
// macro's head, as read. Writing them is macroOptionsWrite.ts: the tokenizer
// brings this module into the entry chunk, and only the lazily loaded table
// code needs the other half. The two mirror server/src/pkm/macro_options.py;
// both sides are held to shared/fixtures/macro_options_parity.json.

export type MacroView = "table" | "cards" | "blocks";
export type SortDir = "asc" | "desc";

export interface MacroOptions {
  view?: MacroView;
  filter?: string;
  sort?: { col: string; dir: SortDir };
  columns?: string[];
}

export const SEPARATOR = " | ";

// Python's str.strip() set, not String.prototype.trim()'s: the two differ
// on U+001C-U+001F, U+0085 and U+FEFF, and a head or value must read the
// same on both sides.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

export const strip = (s: string): string => s.replace(PY_STRIP, "");

/** `body` cut at every ` | ` outside braces and outside [[ ]], so a page
 * title holding ` | ` in a ref never splits. */
function segments(body: string): string[] {
  const out: string[] = [];
  let brace = 0;
  let link = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    if (body.startsWith("[[", i)) {
      link += 1;
      i += 2;
      continue;
    }
    if (body.startsWith("]]", i)) {
      link = Math.max(link - 1, 0);
      i += 2;
      continue;
    }
    const ch = body[i];
    if (ch === "{") brace += 1;
    else if (ch === "}") brace = Math.max(brace - 1, 0);
    else if (brace === 0 && link === 0 && body.startsWith(SEPARATOR, i)) {
      out.push(body.slice(start, i));
      i += SEPARATOR.length;
      start = i;
      continue;
    }
    i += 1;
  }
  out.push(body.slice(start));
  return out;
}

export function splitMacroOptions(
  body: string,
): { head: string; options: MacroOptions } {
  const [head, ...rest] = segments(body);
  const options: MacroOptions = {};
  for (const segment of rest) {
    const colon = segment.indexOf(":");
    if (colon === -1) continue;
    const value = strip(segment.slice(colon + 1));
    if (!value) continue;
    switch (strip(segment.slice(0, colon)).toLowerCase()) {
      case "view":
        if (value === "table" || value === "cards" || value === "blocks") {
          options.view = value;
        }
        break;
      case "filter":
        options.filter = value;
        break;
      case "sort": {
        const space = value.lastIndexOf(" ");
        const col = strip(space === -1 ? "" : value.slice(0, space));
        const dir = value.slice(space + 1);
        if (col && (dir === "asc" || dir === "desc")) {
          options.sort = { col, dir };
        }
        break;
      }
      case "columns": {
        const names = value.split(",").map(strip).filter((c) => c);
        if (names.length > 0) options.columns = names;
        break;
      }
    }
  }
  return { head: strip(head), options: orderedOptions(options) };
}

/** Keys in one order, so options built in any order compare equal. */
export function orderedOptions(o: MacroOptions): MacroOptions {
  const out: MacroOptions = {};
  if (o.view !== undefined) out.view = o.view;
  if (o.filter !== undefined) out.filter = o.filter;
  if (o.sort !== undefined) out.sort = o.sort;
  if (o.columns !== undefined) out.columns = o.columns;
  return out;
}

/** The opener inside a query macro's `{{ }}`; the tokenizer's QUERY_PREFIX
 * is built from it. A table macro has none: its head is the bare name. */
export const QUERY_OPENER = /^(?:\[\[)?query(?:\]\])?:\s*/;

const TABLE_OPENER = /^\{\{(?:table|\[\[table\]\])/i;
const TABLE_HEAD = /^(?:table|\[\[table\]\])$/i;

/** The options of a block whose whole text is a {{table}} macro, either
 * spelling, any case, or null when it is not one. The macro's `{{` must
 * close at the end of the text, as the tokenizer's brace scan closes a
 * macro: otherwise `{{table | a}} x {{y}}` would read ` x {{y` as an option
 * and a rewrite of the options would drop it. */
export function tableMacroOptions(text: string): MacroOptions | null {
  const t = text.trim();
  if (!TABLE_OPENER.test(t) || closeOfFirstBrace(t) !== t.length - 1) {
    return null;
  }
  const { head, options } = splitMacroOptions(t.slice(2, -2));
  return TABLE_HEAD.test(head) ? options : null;
}

/** Index of the `}` matching `t[0]`'s `{`, or -1. */
function closeOfFirstBrace(t: string): number {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "{") depth += 1;
    else if (t[i] === "}" && --depth === 0) return i;
  }
  return -1;
}
