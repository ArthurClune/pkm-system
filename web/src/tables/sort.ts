// pattern: Functional Core
export type SortDir = "asc" | "desc";

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
];

function stripMarkup(text: string): string {
  return text.replace(/\[\[|\]\]|\(\(|\)\)|#/g, "").trim();
}

function isBlank(cell: string | undefined): cell is undefined {
  return cell === undefined || cell.trim() === "";
}

/** Months since year 0, doubled; a bare year sorts before Jan of it. */
function dateKey(text: string): number | null {
  const bare = /^(\d{4})$/.exec(text);
  if (bare) return Number(bare[1]) * 24;
  const m = /^([a-z]+)\s+(\d{4}|\d{2})$/i.exec(text);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const month = MONTHS.findIndex(
    (full) => full === name || (name.length === 3 && full.startsWith(name)),
  );
  if (month === -1) return null;
  const year = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
  return (year * 12 + month) * 2 + 1;
}

function leadingNumber(text: string): number | null {
  if (!/^[\d.]/.test(text)) return null;
  const n = parseFloat(text);
  return Number.isNaN(n) ? null : n;
}

/** Dates rank before numbers, numbers before text. */
function classify(text: string): { rank: number; num: number } {
  const date = dateKey(text);
  if (date !== null) return { rank: 0, num: date };
  const n = leadingNumber(text);
  if (n !== null) return { rank: 1, num: n };
  return { rank: 2, num: 0 };
}

function compareValues(a: string, b: string): number {
  const ca = classify(a);
  const cb = classify(b);
  if (ca.rank !== cb.rank) return ca.rank - cb.rank;
  if (ca.rank < 2) return Math.sign(ca.num - cb.num);
  return Math.sign(
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/** Blanks sort last in both directions; `dir` flips only non-blanks. */
export function compareCells(
  a: string | undefined,
  b: string | undefined,
  dir: SortDir,
): number {
  const blankA = isBlank(a);
  const blankB = isBlank(b);
  if (blankA || blankB) return blankA === blankB ? 0 : blankA ? 1 : -1;
  const order = compareValues(stripMarkup(a!), stripMarkup(b!));
  return dir === "desc" && order !== 0 ? -order : order;
}

/** Stable; returns a new array. */
export function sortRows<T>(
  rows: readonly T[],
  get: (r: T) => string | undefined,
  dir: SortDir,
): T[] {
  // Wrapped because Array.prototype.sort moves bare `undefined` elements to
  // the end without calling the comparator.
  return rows
    .map((row) => ({ row, key: get(row) }))
    .sort((x, y) => compareCells(x.key, y.key, dir))
    .map((entry) => entry.row);
}
