// pattern: Functional Core
// Port of server fts.py: escape untrusted text into FTS5 MATCH expressions.

const quote = (term: string): string => `"${term.replaceAll('"', '""')}"`;

export function escapeFtsQuery(q: string): string {
  const terms = q.trim().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  const quoted = terms.map(quote);
  quoted[quoted.length - 1] += "*";
  return quoted.join(" ");
}

export function phraseQuery(q: string): string {
  return quote(q.trim());
}
