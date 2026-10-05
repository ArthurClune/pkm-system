// pattern: Functional Core
import type { BlockUid } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";

export interface Row {
  uid: BlockUid;
  depth: number;
  text: string;
  heading: BlockNode["heading"];
  viewType: BlockNode["view_type"];
  collapsed: boolean;
  /** Under a collapsed ancestor. */
  hidden: boolean;
}

/** The reading view: depth-first, children in array order. */
export function readingRows(blocks: readonly BlockNode[]): Row[] {
  const rows: Row[] = [];
  const walk = (nodes: readonly BlockNode[], depth: number, hidden: boolean): void => {
    for (const n of nodes) {
      rows.push({
        uid: n.uid, depth, text: n.text, heading: n.heading, viewType: n.view_type,
        collapsed: n.collapsed, hidden,
      });
      walk(n.children, depth + 1, hidden || n.collapsed);
    }
  };
  walk(blocks, 0, false);
  return rows;
}

/** One line per row; collapsed and hidden are view state, not structure. */
export function structural(rows: readonly Row[]): string[] {
  return rows.map((r) =>
    `${r.depth} ${r.uid} ${JSON.stringify(r.text)} ${r.heading ?? "-"} ${r.viewType ?? "document"}`);
}

/** Why the tree is not a valid outline; empty when it is. */
export function treeProblems(blocks: readonly BlockNode[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const walk = (nodes: readonly BlockNode[], where: string): void => {
    nodes.forEach((n, i) => {
      if (seen.has(n.uid)) problems.push(`duplicate uid ${n.uid}`);
      seen.add(n.uid);
      if (i > 0) {
        const prev = nodes[i - 1];
        if (n.order_idx === prev.order_idx) {
          problems.push(`siblings ${prev.uid} and ${n.uid} under ${where} share order_idx ${n.order_idx}`);
        } else if (n.order_idx < prev.order_idx) {
          problems.push(`siblings under ${where} not sorted by order_idx: ${prev.uid} (${prev.order_idx}) before ${n.uid} (${n.order_idx})`);
        }
      }
      walk(n.children, n.uid);
    });
  };
  walk(blocks, "the page");
  return problems;
}

/** null when the rows are equal, else the first differing index with both rows. */
export function rowsDiff(expected: readonly Row[], actual: readonly Row[]): string | null {
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) {
      return `row ${i} differs: expected ${JSON.stringify(expected[i])}, actual ${JSON.stringify(actual[i])}`;
    }
  }
  if (expected.length !== actual.length) {
    return `length differs: expected ${expected.length} rows, actual ${actual.length}`;
  }
  return null;
}
