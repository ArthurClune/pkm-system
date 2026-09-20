// pattern: Functional Core
// Derive a page's table of contents from its block tree (pkm-mzks). Nothing
// is stored: the {{toc}} block holds only the macro text, and this walk runs
// on every render of an unfocused toc block, so a heading edit shows up in
// the list immediately.
import type { BlockNode } from "../api/payloads";
import { tokenizeBlock, type BlockSegment } from "../grammar/tokenize";

export interface TocEntry {
  uid: string;
  /** The heading as plain text: refs reduced to their titles, emphasis
   * unwrapped, so a `## [[Mathematics]]` heading lists as "Mathematics"
   * (pkm-2rdp). */
  text: string;
  level: 1 | 2 | 3;
  children: TocEntry[];
}

/** The two spellings of the macro, matching roamTableRows' TABLE_MACRO. */
const TOC_MACRO = /^(?:\{\{toc\}\}|\{\{\[\[toc\]\]\}\})$/i;

export function isTocMacro(text: string): boolean {
  return TOC_MACRO.test(text.trim());
}

/** Plain-text reading of a heading, on the same tokenizer InlineSegments
 * renders from, so the toc lists what the heading says minus its markup.
 * Block-level segments (todo marker, code fence, query, pdf) contribute
 * nothing: none of them is heading prose. */
export function headingText(text: string): string {
  const flat = (seg: BlockSegment): string => {
    switch (seg.kind) {
      case "text": return seg.text;
      case "linebreak": return " ";
      case "inline-code": return seg.code;
      case "page-ref": return seg.tag ? `#${seg.title}` : seg.title;
      case "attribute": return seg.name;
      case "block-ref": return `((${seg.uid}))`;
      case "image": return seg.alt;
      case "link": return seg.text;
      case "asset-link": return seg.filename;
      case "math": return seg.tex;
      case "bold": case "italic": case "strike": case "highlight":
        return seg.children.map(flat).join("");
      case "todo": case "code-block": case "query": case "pdf-embed":
        return "";
    }
  };
  return tokenizeBlock(text).map(flat).join("").trim();
}

function isHeading(node: BlockNode): node is BlockNode & { heading: 1 | 2 | 3 } {
  return node.heading === 1 || node.heading === 2 || node.heading === 3;
}

/** The page's headings, nested by OUTLINE depth rather than heading level:
 * an entry's parent is its nearest heading ancestor, so an h3 indented under
 * an h1 (however many plain blocks sit between them) is a child of that h1,
 * and a heading with no heading ancestor is top level.
 *
 * `selfUid` is the toc block, skipped as an entry -- but its subtree is still
 * walked, so a heading indented under the toc block gets listed. Collapsed
 * subtrees are walked too: the contents page describes the page, not the
 * currently visible part of it.
 */
export function tocEntries(blocks: BlockNode[], selfUid: string): TocEntry[] {
  const top: TocEntry[] = [];
  const walk = (nodes: BlockNode[], into: TocEntry[]) => {
    for (const node of nodes) {
      if (node.uid !== selfUid && isHeading(node)) {
        const entry: TocEntry = {
          uid: node.uid, text: headingText(node.text), level: node.heading, children: [],
        };
        into.push(entry);
        walk(node.children, entry.children);
      } else {
        walk(node.children, into);
      }
    }
  };
  walk(blocks, top);
  return top;
}
