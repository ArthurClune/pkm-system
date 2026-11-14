// pattern: Imperative Shell
import type { FindMatch } from "./findMatches";

export const FIND_ROOTS_SELECTOR = ".main-pane, .sidebar";

export type PageText = { groups: string[][]; nodes: Text[][] };

const SKIPPED = "textarea, input, script, style, noscript";

// One group is the text a reader sees as one run, so a phrase across a link
// or other inline markup is found. A block's text and a reference's text are
// a group each; other text joins its nearest block-level element. A row's
// chrome (list number, reference badge, stamp) stays out of the block's
// text and apart from each other.
const TEXT_UNIT = ".block-text, .backlink-text";
const BLOCK_LEVEL =
  "p, li, h1, h2, h3, h4, h5, h6, td, th, pre, blockquote, div";

function groupKey(parent: Element, root: Element): Element {
  const unit = parent.closest(TEXT_UNIT);
  if (unit) return unit;
  if (parent.closest(".block-row")) return parent;
  const block = parent.closest(BLOCK_LEVEL);
  return block && root.contains(block) ? block : parent;
}

type MaybeVisible = Element & { checkVisibility?: () => boolean };

function searchable(node: Text): boolean {
  const parent = node.parentElement;
  if (!parent || node.data.trim() === "") return false;
  if (parent.closest(SKIPPED)) return false;
  return (parent as MaybeVisible).checkVisibility?.() !== false;
}

export function collectPageText(roots: readonly Element[]): PageText {
  const groups: string[][] = [];
  const nodes: Text[][] = [];
  let lastKey: Element | null = null;
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n as Text;
      if (!searchable(text)) continue;
      const parent = text.parentElement!;
      const key = groupKey(parent, root);
      if (key !== lastKey) {
        groups.push([]);
        nodes.push([]);
        lastKey = key;
      }
      groups[groups.length - 1].push(text.data);
      nodes[nodes.length - 1].push(text);
    }
  }
  return { groups, nodes };
}

export function matchRange(text: PageText, m: FindMatch): Range {
  const range = document.createRange();
  range.setStart(text.nodes[m.group][m.start.node], m.start.offset);
  range.setEnd(text.nodes[m.group][m.end.node], m.end.offset);
  return range;
}
