// pattern: Functional Core
// Generators and an independent model for the properties over which block
// rows the editor shows: trees with collapsed blocks, valid and invalid Roam
// {{table}} macros, headings and view modes. The model is written from the
// render rules in "Rules an edit must not break" in
// docs/architecture/frontend-editor.md, not from tree.ts.
import fc from "fast-check";
import type { BlockUid } from "../../api/brands";
import type { BlockNode } from "../../api/payloads";
import { block, orderIdxOf, uidOf } from "../../test-helpers";

/** A tree before uids are assigned: shape only. */
interface Shape {
  text: string;
  collapsed: boolean;
  heading: BlockNode["heading"];
  view: BlockNode["view_type"];
  kids: Shape[];
}

const PLAIN = fc.constantFrom(
  "a", "text", "x y", "", "\u{1F600} hi", "é\u{1D11E}", "{{table}} x",
  "{{tables}}", "{{[[table]]", "table",
);
const MACRO = fc.constantFrom(
  "{{table}}", "{{[[table]]}}", " {{TABLE}} ", "{{[[Table]]}}\n",
);
const HEADING = fc.constantFrom(null, null, null, 1, 2, 3) as
  fc.Arbitrary<BlockNode["heading"]>;
const VIEW = fc.constantFrom(null, null, "numbered", "document") as
  fc.Arbitrary<BlockNode["view_type"]>;
const COLLAPSED = fc.integer({ min: 0, max: 2 }).map((n) => n === 0);

const leaf = (text: string, over: Partial<Shape> = {}): Shape => ({
  text, collapsed: false, heading: null, view: null, kids: [], ...over,
});

interface Cell { text: string; collapsed: boolean; fork: boolean }

/** A macro block whose rows are chains of cells; a `fork` cell gets a second
 * child, which makes the grid invalid (a cell holds at most one child). */
const tableArb: fc.Arbitrary<Shape> = fc.record({
  text: MACRO, collapsed: COLLAPSED, heading: HEADING, view: VIEW,
  rows: fc.array(
    fc.array(
      fc.record({
        text: PLAIN, collapsed: COLLAPSED,
        fork: fc.integer({ min: 0, max: 7 }).map((n) => n === 0),
      }),
      { minLength: 1, maxLength: 3 }),
    { maxLength: 3 }),
}).map(({ rows, ...rest }) => {
  const chain = (cells: Cell[]): Shape => {
    const [head, ...tail] = cells;
    const kids = tail.length > 0 ? [chain(tail)] : [];
    if (head.fork) kids.push(leaf("fork"));
    return leaf(head.text, { collapsed: head.collapsed, kids });
  };
  return { ...rest, kids: rows.map(chain) };
});

const shapeArb: fc.Arbitrary<Shape> = fc.letrec<{ node: Shape }>((tie) => ({
  node: fc.oneof(
    { maxDepth: 3 },
    { weight: 2, arbitrary: fc.record({
      text: PLAIN, collapsed: COLLAPSED, heading: HEADING, view: VIEW,
      kids: fc.constant([] as Shape[]),
    }) },
    { weight: 3, arbitrary: fc.record({
      text: PLAIN, collapsed: COLLAPSED, heading: HEADING, view: VIEW,
      kids: fc.array(tie("node"), { maxLength: 3 }),
    }) },
    { weight: 2, arbitrary: tableArb },
    { weight: 1, arbitrary: fc.record({
      text: MACRO, collapsed: COLLAPSED, heading: HEADING, view: VIEW,
      kids: fc.array(tie("node"), { maxLength: 3 }),
    }) },
  ),
})).node;

/** Top-level blocks: one to four of the above. Unique uids, order_idx by
 * position. */
export const treeArb: fc.Arbitrary<BlockNode[]> = fc
  .array(shapeArb, { minLength: 1, maxLength: 4 })
  .map((shapes) => {
    let n = 0;
    const build = (list: Shape[]): BlockNode[] =>
      list.map((s, i) => block(`tuid-n${n++}`, s.text, {
        collapsed: s.collapsed, heading: s.heading, view_type: s.view,
        order_idx: orderIdxOf(i), children: build(s.kids),
      }));
    return build(shapes);
  });

export function allNodes(blocks: readonly BlockNode[]): BlockNode[] {
  return blocks.flatMap((n) => [n, ...allNodes(n.children)]);
}

/** The uids from the outermost ancestor down to `uid`; empty if absent. */
export function pathTo(blocks: readonly BlockNode[], uid: BlockUid): BlockUid[] {
  for (const n of blocks) {
    if (n.uid === uid) return [uid];
    const below = pathTo(n.children, uid);
    if (below.length > 0) return [n.uid, ...below];
  }
  return [];
}

export const isMacro = (text: string): boolean =>
  ["{{table}}", "{{[[table]]}}"].includes(text.trim().toLowerCase());

const chainOk = (cell: BlockNode): boolean =>
  cell.children.length <= 1
  && (cell.children.length === 0 || chainOk(cell.children[0]));

/** Whether the block renders as a Roam table grid: the macro text, at least
 * one row, every row a chain whose cells each hold at most one child. */
export const isTable = (n: BlockNode): boolean =>
  isMacro(n.text) && n.children.length > 0 && n.children.every(chainOk);

/** The block rows on screen, in order. A valid table shows its cells as rows
 * only when `revealed` holds its uid (the focus is in its subtree); every
 * other collapsed block with children hides them. */
export function modelRows(
  blocks: readonly BlockNode[], revealed: (uid: BlockUid) => boolean,
): BlockUid[] {
  const out: BlockUid[] = [];
  const walk = (list: readonly BlockNode[]): void => {
    for (const n of list) {
      out.push(n.uid);
      if (isTable(n)) {
        if (revealed(n.uid)) walk(n.children);
      } else if (!n.collapsed) {
        walk(n.children);
      }
    }
  };
  walk(blocks);
  return out;
}

export const uidFor = (index: number): BlockUid => uidOf(`tuid-n${index}`);
