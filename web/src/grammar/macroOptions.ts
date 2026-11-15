// pattern: Functional Core
// The ` | name: value` options after a {{query: ...}} or {{table ...}}
// macro's head. Mirrors server/src/pkm/macro_options.py; both are held to
// shared/fixtures/macro_options_parity.json.
//
// An option adds no refs: refs extraction scans the whole macro, so ref
// syntax in an option value would become a ref. `optionsRefusal` keeps it out
// at Save instead of teaching both extractors about options.

export type MacroView = "table" | "cards" | "blocks";
export type SortDir = "asc" | "desc";

export interface MacroOptions {
  view?: MacroView;
  filter?: string;
  sort?: { col: string; dir: SortDir };
  columns?: string[];
}

const SEPARATOR = " | ";
const REFUSED = ["[[", "]]", "#", "|", "{", "}"] as const;

// Python's str.strip() set, not String.prototype.trim()'s: the two differ
// on U+001C-U+001F, U+0085 and U+FEFF, and a head or value must read the
// same on both sides.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a"
  + "\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

const strip = (s: string): string => s.replace(PY_STRIP, "");

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
  return { head: strip(head), options: ordered(options) };
}

/** Keys in one order, so options built in any order compare equal. */
function ordered(o: MacroOptions): MacroOptions {
  const out: MacroOptions = {};
  if (o.view !== undefined) out.view = o.view;
  if (o.filter !== undefined) out.filter = o.filter;
  if (o.sort !== undefined) out.sort = o.sort;
  if (o.columns !== undefined) out.columns = o.columns;
  return out;
}

/** What `o` reads back as after a save: every value trimmed, empty column
 * names dropped, and a filter, sort or column list left with nothing
 * omitted. */
export function normaliseMacroOptions(o: MacroOptions): MacroOptions {
  const filter = o.filter !== undefined ? strip(o.filter) : "";
  const col = o.sort !== undefined ? strip(o.sort.col) : "";
  const names = (o.columns ?? []).map(strip).filter((c) => c);
  return ordered({
    view: o.view,
    filter: filter || undefined,
    sort: o.sort !== undefined && col ? { col, dir: o.sort.dir } : undefined,
    columns: names.length > 0 ? names : undefined,
  });
}

export function formatMacroOptions(o: MacroOptions): string {
  const n = normaliseMacroOptions(o);
  const parts: string[] = [];
  if (n.view !== undefined) parts.push(`view: ${n.view}`);
  if (n.filter !== undefined) parts.push(`filter: ${n.filter}`);
  if (n.sort !== undefined) parts.push(`sort: ${n.sort.col} ${n.sort.dir}`);
  if (n.columns !== undefined) parts.push(`columns: ${n.columns.join(", ")}`);
  return parts.map((p) => SEPARATOR + p).join("");
}

// Python's str.isprintable() is false for these categories (space aside),
// and repr() escapes them.
const UNPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

/** Python's repr() of a str, so the refusal reads the same on both sides. */
function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\" || ch === quote) out += "\\" + ch;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch !== " " && UNPRINTABLE.test(ch)) {
      const hex = code.toString(16);
      out += code < 0x100 ? "\\x" + hex.padStart(2, "0")
        : code < 0x10000 ? "\\u" + hex.padStart(4, "0")
        : "\\U" + hex.padStart(8, "0");
    } else out += ch;
  }
  return out + quote;
}

/** Why `o` cannot be saved into a macro, or null. Names the first offending
 * character so the message can say what to remove. Padding and empty values
 * are not refused: `normaliseMacroOptions` absorbs them. */
export function optionsRefusal(o: MacroOptions): string | null {
  const values: string[] = [];
  if (o.filter !== undefined) values.push(o.filter);
  if (o.sort !== undefined) values.push(o.sort.col);
  if (o.columns !== undefined) {
    values.push(...o.columns);
    for (const column of o.columns) {
      if (column.includes(",")) {
        return `A column name cannot contain ',': ${pyRepr(column)}`;
      }
    }
  }
  for (const value of values) {
    for (const char of REFUSED) {
      if (value.includes(char)) {
        return `A saved view cannot contain ${pyRepr(char)}: ${pyRepr(value)}`;
      }
    }
  }
  return null;
}

/** The opener inside a query macro's `{{ }}`, the tokenizer's QUERY_PREFIX
 * without the braces. A table macro has none: its head is the bare name. */
const QUERY_OPENER = /^(?:\[\[)?query(?:\]\])?:\s*/;

/** `text` with the macro at `span` (its whole `{{...}}`, as the tokenizer
 * reports it) carrying `o` as its options in place of its own. The opener
 * and expression keep their spelling. */
export function rewriteMacroOptions(
  text: string, span: readonly [number, number], o: MacroOptions,
): string {
  const [start, end] = span;
  const inner = text.slice(start + 2, end - 2);
  const lead = QUERY_OPENER.exec(inner)?.[0] ?? "";
  const { head } = splitMacroOptions(inner.slice(lead.length));
  return text.slice(0, start) + "{{" + lead + head + formatMacroOptions(o)
    + "}}" + text.slice(end);
}

const TABLE_OPENER = /^\{\{(?:table|\[\[table\]\])/i;
const TABLE_HEAD = /^(?:table|\[\[table\]\])$/i;

/** The options of a block whose whole text is a {{table}} macro, either
 * spelling, any case, or null when it is not one. */
export function tableMacroOptions(text: string): MacroOptions | null {
  const t = text.trim();
  if (!TABLE_OPENER.test(t) || !t.endsWith("}}")) return null;
  const { head, options } = splitMacroOptions(t.slice(2, -2));
  return TABLE_HEAD.test(head) ? options : null;
}
