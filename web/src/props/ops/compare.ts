// pattern: Functional Core
// Comparison forms for the ops property: per-page trees from a server
// snapshot, tree diffs, pruning of the rows the server mints itself (conflict
// notes, daily pages), and a sibling-rank view of a graph for the checks that
// care about order but not key values.
import type { BlockNode } from "../../api/payloads";
import type { Snapshot, SyncBlock } from "../../replica/apply";
import type { NormalBlock, NormalGraph } from "../sync/normalise";

const byOrder = (a: SyncBlock, b: SyncBlock): number =>
  a.order_idx - b.order_idx || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);

/** One tree per title (empty for an absent page), children by `order_idx`
 * with the uid as tie-break, timestamps null. */
export function treesFromSnapshot(s: Snapshot,
                                  titles: readonly string[]): Map<string, BlockNode[]> {
  const pageId = new Map<string, number>(s.pages.map((p) => [p.title, p.id]));
  const out = new Map<string, BlockNode[]>();
  for (const title of titles) {
    const id = pageId.get(title);
    const rows = id === undefined ? [] : s.blocks.filter((b) => b.page_id === id);
    const kids = new Map<string | null, SyncBlock[]>();
    for (const b of rows) kids.set(b.parent_uid, [...(kids.get(b.parent_uid) ?? []), b]);
    const build = (parent: string | null): BlockNode[] =>
      (kids.get(parent) ?? []).slice().sort(byOrder).map((b): BlockNode => ({
        uid: b.uid,
        text: b.text,
        heading: b.heading,
        view_type: b.view_type,
        collapsed: b.collapsed !== 0,
        order_idx: b.order_idx,
        created_at: null,
        updated_at: null,
        children: build(b.uid),
      }));
    out.set(title, build(null));
  }
  return out;
}

/** Drops every node whose uid is not in `known`, with its subtree. */
export function pruneTree(tree: BlockNode[], known: ReadonlySet<string>): BlockNode[] {
  return tree.filter((n) => known.has(n.uid))
    .map((n) => ({ ...n, children: pruneTree(n.children, known) }));
}

interface Flat {
  parent: string | null;
  position: number;
  node: BlockNode;
}

function flatten(tree: BlockNode[], parent: string | null, out: Map<string, Flat>): void {
  tree.forEach((node, position) => {
    out.set(node.uid, { parent, position, node });
    flatten(node.children, node.uid, out);
  });
}

const show = (v: unknown): string => JSON.stringify(v) ?? "undefined";

/** One line per difference, naming the uid; `[]` when equal. A uid's parent
 * and its position among siblings are reported apart from its `order_idx`,
 * so a key drift that keeps order reads differently from a reorder. */
export function diffTrees(a: BlockNode[], b: BlockNode[],
                          names: readonly [string, string]): string[] {
  const [na, nb] = names;
  const fa = new Map<string, Flat>();
  const fb = new Map<string, Flat>();
  flatten(a, null, fa);
  flatten(b, null, fb);
  const lines: string[] = [];
  for (const uid of [...new Set([...fa.keys(), ...fb.keys()])].sort()) {
    const x = fa.get(uid);
    const y = fb.get(uid);
    if (!y) { lines.push(`${uid}: only in ${na}`); continue; }
    if (!x) { lines.push(`${uid}: only in ${nb}`); continue; }
    const fields: [string, unknown, unknown][] = [
      ["parent", x.parent, y.parent],
      ["position", x.position, y.position],
      ["order_idx", x.node.order_idx, y.node.order_idx],
      ["text", x.node.text, y.node.text],
      ["heading", x.node.heading, y.node.heading],
      ["view_type", x.node.view_type, y.node.view_type],
      ["collapsed", x.node.collapsed, y.node.collapsed],
    ];
    for (const [f, p, q] of fields) {
      if (show(p) !== show(q)) lines.push(`${uid}: ${f} ${show(p)} (${na}) vs ${show(q)} (${nb})`);
    }
  }
  return lines;
}

/** Drops blocks whose uid is not in `known`, then pages not in `keepPages`
 * that no kept block lives on and no kept block's refs name. */
export function pruneGraph(g: NormalGraph, known: ReadonlySet<string>,
                           keepPages: ReadonlySet<string>): NormalGraph {
  const blocks = g.blocks.filter((b) => known.has(b.uid));
  const used = new Set<string>(keepPages);
  for (const b of blocks) {
    used.add(b.page);
    // Refs are `kind:title`; titles can contain ':'.
    for (const r of b.refs) used.add(r.slice(r.indexOf(":") + 1));
  }
  return { ...g, pages: g.pages.filter((p) => used.has(p)), blocks };
}

/** Each block's `order_idx` replaced by its 0-based rank among the blocks
 * sharing its page and parent. */
export function rankOrder(g: NormalGraph): NormalGraph {
  const groups = new Map<string, NormalBlock[]>();
  for (const b of g.blocks) {
    const key = JSON.stringify([b.page, b.parent_uid]);
    groups.set(key, [...(groups.get(key) ?? []), b]);
  }
  const rank = new Map<string, number>();
  for (const group of groups.values()) {
    group.slice().sort((x, y) => x.order_idx - y.order_idx || (x.uid < y.uid ? -1 : 1))
      .forEach((b, i) => rank.set(b.uid, i));
  }
  return { ...g, blocks: g.blocks.map((b) => ({ ...b, order_idx: rank.get(b.uid) ?? 0 })) };
}
