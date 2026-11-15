// pattern: Functional Core
export interface FilterTerm {
  neg: boolean;
  col: string | null;
  value: string;
}

export type FilterRow = Readonly<Record<string, string | undefined>>;

const WORD = /[\p{L}\p{N}.]+/gu;

function wordsOf(text: string): string[] {
  const plain = text.toLowerCase().replace(/\[\[|\]\]|\(\(|\)\)|#/g, "");
  return plain.match(WORD) ?? [];
}

/** Never throws: a lone `-` or an unclosed quote becomes literal text. */
export function parseFilter(text: string): FilterTerm[] {
  const terms: FilterTerm[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    let neg = false;
    if (text[i] === "-" && i + 1 < n && !/\s/.test(text[i + 1]!)) {
      neg = true;
      i++;
    }
    let col: string | null = null;
    const head = /^[^\s":]+:/.exec(text.slice(i));
    if (head) {
      col = head[0].slice(0, -1);
      i += head[0].length;
    }
    let value: string;
    if (text[i] === '"') {
      const close = text.indexOf('"', i + 1);
      if (close === -1) {
        value = text.slice(i + 1);
        i = n;
      } else {
        value = text.slice(i + 1, close);
        i = close + 1;
      }
    } else {
      const bare = /^\S*/.exec(text.slice(i))![0];
      value = bare;
      i += bare.length;
    }
    terms.push({ neg, col, value });
  }
  return terms;
}

function cellHasPhrase(cell: string | undefined, phrase: string[]): boolean {
  if (phrase.length === 0) return true;
  const words = wordsOf(cell ?? "");
  for (let s = 0; s + phrase.length <= words.length; s++) {
    if (phrase.every((p, k) => words[s + k]!.startsWith(p))) return true;
  }
  return false;
}

function holds(
  row: FilterRow,
  term: FilterTerm,
  columns: readonly string[],
): boolean {
  let searched = columns;
  if (term.col !== null) {
    const prefix = wordsOf(term.col)[0] ?? "";
    searched = columns.filter((c) =>
      wordsOf(c).some((w) => w.startsWith(prefix)),
    );
    if (searched.length === 0) return false;
  }
  if (term.col !== null && term.value === "") {
    return searched.every((c) => (row[c] ?? "").trim() === "");
  }
  const phrase = wordsOf(term.value);
  return searched.some((c) => cellHasPhrase(row[c], phrase));
}

export function matchesFilter(
  row: FilterRow,
  terms: FilterTerm[],
  columns: readonly string[],
): boolean {
  return terms.every((t) => holds(row, t, columns) !== t.neg);
}
