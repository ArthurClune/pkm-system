// pattern: Functional Core
// Saving a view into a {{query}} or {{table}} macro's options: what options
// read back as, their text, why some cannot be saved, and the rewrite of a
// macro in a block's text. The reading half is macroOptions.ts.
//
// An option adds no refs: refs extraction scans the whole macro, so ref
// syntax in an option value would become a ref. `optionsRefusal` keeps it out
// at Save instead of teaching both extractors about options.
import {
  QUERY_OPENER, SEPARATOR, orderedOptions, splitMacroOptions, strip,
  type MacroOptions,
} from "./macroOptions";

const REFUSED = ["[[", "]]", "#", "|", "{", "}"] as const;

/** What `o` reads back as after a save: every value trimmed, empty column
 * names dropped, and a filter, sort or column list left with nothing
 * omitted. */
export function normaliseMacroOptions(o: MacroOptions): MacroOptions {
  const filter = o.filter !== undefined ? strip(o.filter) : "";
  const col = o.sort !== undefined ? strip(o.sort.col) : "";
  const names = (o.columns ?? []).map(strip).filter((c) => c);
  return orderedOptions({
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

