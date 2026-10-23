// pattern: Functional Core
// The structured write preview a confirm_request carries, shape-checked, and
// the quoting the approval card renders its values with. Keys, warnings and
// the action are labels the card shows unquoted, so the parser escapes them;
// target values and content are escaped when the card quotes them.

export type PreviewOp = {
  action: string;
  targets: [string, unknown][];
  content: [string, string, number][];
  warnings: string[];
};
export type WritePreview = { ops: PreviewOp[]; summary: string };

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function parseTarget(raw: unknown): [string, unknown] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [key, value] = raw as unknown[];
  return typeof key === "string" ? [escapeLabel(key), value] : null;
}

function parseContent(raw: unknown): [string, string, number] | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [key, value, total] = raw as unknown[];
  if (typeof key !== "string" || typeof value !== "string") return null;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    return null;
  }
  // total is the server's len of the value, in code points. The server
  // sends content whole, so any other length would make the card misstate
  // what it shows, or have the user approve a tail never sent
  if ([...value].length !== total) return null;
  return [escapeLabel(key), value, total];
}

function parseAll<T>(raw: unknown, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) return null;
  const out: T[] = [];
  for (const item of raw as unknown[]) {
    const parsed = parse(item);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseOp(raw: unknown): PreviewOp | null {
  if (!isRecord(raw) || typeof raw.action !== "string") return null;
  const targets = parseAll(raw.targets, parseTarget);
  const content = parseAll(raw.content, parseContent);
  const warnings = parseAll(raw.warnings,
    (w) => (typeof w === "string" ? escapeWarning(w) : null));
  if (targets === null || content === null || warnings === null) return null;
  return { action: escapeLabel(raw.action), targets, content, warnings };
}

/** The preview rebuilt from `raw` field by field, or null when any field has
 * the wrong type. No ops is also null: a card listing nothing must not offer
 * Allow. */
export function parseWritePreview(raw: unknown): WritePreview | null {
  if (!isRecord(raw) || typeof raw.summary !== "string") return null;
  const ops = parseAll(raw.ops, parseOp);
  if (ops === null || ops.length === 0) return null;
  return { ops, summary: raw.summary };
}

// Controls (C0, DEL, C1), format characters (bidi overrides and isolates,
// zero-width marks, BOM, tags), line and paragraph separators, lone
// surrogates, and the Hangul and Braille fillers, which are letters or
// symbols that draw as blank space. The u flag matches an astral character
// as one code point.
const NON_PRINTABLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\u115F\u1160\u3164\uFFA0\u2800]/gu;

// Each UTF-16 unit as \uXXXX, so an astral character becomes its surrogate
// pair: the same form JSON uses, and valid inside a JSON string.
function escapeUnits(ch: string): string {
  let out = "";
  for (let i = 0; i < ch.length; i++) {
    out += "\\u" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

// A run of combining marks at the start, after a quote or after a newline
// would draw onto the card's quote glyph or begin a line, so it is escaped;
// on any other character it stays, as the accent it is.
const LEADING_MARKS = /(?<=^|["\n])\p{M}+/gu;

function escapeNonPrintable(s: string, keepNewline = true): string {
  return s
    .replace(NON_PRINTABLE,
      (ch) => (ch === "\n" && keepNewline ? ch : escapeUnits(ch)))
    .replace(LEADING_MARKS, escapeUnits);
}

// A label is one line, so its newlines are escaped too. A backslash doubles,
// so a key written `uid\u0022` cannot pass for an escape the card made.
function escapeLabel(s: string): string {
  return escapeNonPrintable(s.replace(/\\/g, "\\\\"), false);
}

// The server JSON-quotes every value inside a warning, so its backslashes
// are escapes already; doubling them would make `\"` read as a closing quote.
function escapeWarning(s: string): string {
  return escapeNonPrintable(s, false);
}

/** `s` in double quotes with `"` and `\` escaped and every non-printable
 * written as `\uXXXX`, as are combining marks that would draw onto a quote or
 * begin a line. By default a newline stays a line break so a note reads as
 * one, yet no line inside it can close the quote. */
export function quoteValue(s: string, keepNewline = true): string {
  const escaped = s.replace(/["\\]/g, (ch) => "\\" + ch);
  return '"' + escapeNonPrintable(escaped, keepNewline) + '"';
}

/** How the card writes one target value. A target is one line, so a newline
 * in it is escaped: kept, it would start a line under the key column. A null
 * `page` is today's daily note; the server refuses every key the tool does
 * not declare, so this `page` is always the tool's own. JSON.stringify leaves
 * DEL, C1 and format characters raw, so its output is escaped as a quoted
 * string is. */
export function formatTarget(key: string, value: unknown): string {
  if (value === null) return key === "page" ? "today's daily note" : "none";
  if (typeof value === "string") return quoteValue(value, false);
  return escapeNonPrintable(JSON.stringify(value) ?? String(value));
}
