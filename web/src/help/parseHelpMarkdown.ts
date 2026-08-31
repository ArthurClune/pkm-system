// pattern: Functional Core
/** Parser for the narrow markdown subset used by docs/keyboard.md: #/##/###
 * headings, paragraphs (consecutive plain lines joined with a space), pipe
 * tables, and inline backtick code spans. Deliberately not the app's block
 * grammar (grammar/tokenize.ts) -- that grammar is inline-only over a single
 * block's text (block structure comes from the outline, so it offers no
 * headings, paragraphs, or pipe tables to a multi-line doc) -- and
 * deliberately not a markdown dependency -- the subset is small and fixed.
 * The doc's literal `[[page]]`/`((...))` in backticks would be safe either
 * way: grammar/scan.ts blanks code spans before reference recognition. */

export interface InlineSegment {
  code: boolean;
  text: string;
}

export type Inline = InlineSegment[];

export type HelpBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inline: Inline }
  | { kind: "paragraph"; inline: Inline }
  | { kind: "table"; header: Inline[]; rows: Inline[][] };

const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const SEPARATOR_ROW_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/** Splits a line's cells on `|`, backtick code spans never contain a pipe in
 * this doc so no escaping is needed. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => cell.trim());
}

function isTableStart(line: string, nextLine: string | undefined): boolean {
  return line.trim().startsWith("|") && nextLine !== undefined
    && SEPARATOR_ROW_RE.test(nextLine.trim());
}

/** Splits on backtick pairs; odd-indexed pieces (between an opening and
 * closing backtick) are code spans. Every backtick in the doc is paired, so
 * there's no unterminated-span case to handle. */
function parseInline(text: string): Inline {
  const segments: Inline = [];
  const parts = text.split("`");
  parts.forEach((part, i) => {
    if (part === "") return;
    segments.push({ code: i % 2 === 1, text: part });
  });
  return segments;
}

export function parseHelpMarkdown(markdown: string): HelpBlock[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: HelpBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1].length as 1 | 2 | 3,
        inline: parseInline(headingMatch[2].trim()),
      });
      i++;
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const header = splitRow(line).map(parseInline);
      i += 2; // header row + separator row
      const rows: Inline[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]).map(parseInline));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const paraLines: string[] = [];
    while (
      i < lines.length
      && lines[i].trim() !== ""
      && !HEADING_RE.test(lines[i])
      && !isTableStart(lines[i], lines[i + 1])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    blocks.push({ kind: "paragraph", inline: parseInline(paraLines.join(" ")) });
  }

  return blocks;
}
