// pattern: Imperative Shell
import type { FindMatch } from "./findMatches";

export const FIND_ROOTS_SELECTOR = ".main-pane, .sidebar";

export type PageText = { groups: string[][]; nodes: Text[][] };

const SKIPPED = "textarea, input, script, style, noscript";

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
      const key = parent.closest(".block-row") ?? parent;
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
