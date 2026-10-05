// pattern: Functional Core
import fc from "fast-check";
import type { BlockUid, CanonicalTitle, OrderIdx } from "../../api/brands";
import type { SetViewTypeOp } from "../../api/ops";
import type { BlockNode } from "../../api/payloads";
import type { PastedNode } from "../../outline/paste";

export const PAGE_TITLE = "Outline Props" as CanonicalTitle;

const MAX_BLOCKS = 30;
const TREE_MAX_DEPTH = 4; // depth index of the deepest level: five levels
const FOREST_MAX_DEPTH = 3;

const BLOCK_TEXT = fc.constantFrom("", "a", "ab", "hello", " lead", "- dash", "x y");
// Non-empty, no leading whitespace, no bullet marker, no newline: what survives
// a render-and-parse round trip in every indent style.
const PASTE_TEXT = fc.constantFrom("p", "q r", "[[Link]]", "z");

/** Flat generation order -> nesting: each entry sits at most one level below
 * its predecessor, so any array of picks yields a well-formed forest. */
function depthsFor(picks: readonly number[], maxDepth: number): number[] {
  const depths: number[] = [];
  let prev = -1;
  for (const pick of picks) {
    const d = Math.min(pick % (prev + 2), maxDepth);
    depths.push(d);
    prev = d;
  }
  return depths;
}

interface Slot { depth: number }

function nest<S extends Slot, N extends { children: N[] }>(
  slots: readonly S[], make: (s: S, siblings: N[]) => N,
): N[] {
  const roots: N[] = [];
  const stack: N[][] = [roots];
  for (const s of slots) {
    const siblings = stack[s.depth];
    const node = make(s, siblings);
    siblings.push(node);
    stack.length = s.depth + 1;
    stack.push(node.children);
  }
  return roots;
}

const gapArb = fc.oneof(
  { arbitrary: fc.constant(0), weight: 3 },
  { arbitrary: fc.integer({ min: 1, max: 4 }), weight: 1 },
);

const blockSpecArb = fc.record({
  pick: fc.nat(),
  text: BLOCK_TEXT,
  first: fc.nat(3),
  gap: gapArb,
  collapsed: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
  heading: fc.constantFrom<BlockNode["heading"]>(null, 1, 2, 3),
  viewType: fc.constantFrom<BlockNode["view_type"]>(null, "document", "numbered"),
});

export const treeArb: fc.Arbitrary<BlockNode[]> = fc
  .array(blockSpecArb, { minLength: 1, maxLength: MAX_BLOCKS })
  .map((specs) => {
    const depths = depthsFor(specs.map((s) => s.pick), TREE_MAX_DEPTH);
    let n = 0;
    return nest<Slot & (typeof specs)[number], BlockNode>(
      specs.map((s, i) => ({ ...s, depth: depths[i] })),
      (s, siblings) => {
        const prev = siblings[siblings.length - 1];
        return {
          uid: `b${n++}` as BlockUid,
          text: s.text,
          heading: s.heading,
          view_type: s.viewType,
          collapsed: s.collapsed,
          order_idx: (prev ? prev.order_idx + 1 + s.gap : s.first) as OrderIdx,
          created_at: null,
          updated_at: null,
          children: [],
        };
      },
    );
  });

export type IndentStyle = "two" | "four" | "tab" | "bullet";

export function renderForest(forest: PastedNode[], style: IndentStyle): string {
  const indent = style === "four" ? "    " : style === "tab" ? "\t" : "  ";
  const prefix = style === "bullet" ? "- " : "";
  const lines: string[] = [];
  const walk = (nodes: PastedNode[], depth: number): void => {
    for (const n of nodes) {
      lines.push(`${indent.repeat(depth)}${prefix}${n.text}`);
      walk(n.children, depth + 1);
    }
  };
  walk(forest, 0);
  return lines.join("\n");
}

const styleArb = fc.constantFrom<IndentStyle>("two", "four", "tab", "bullet");

// Only forests that carry structure, so every render is an outline paste.
export const forestArb: fc.Arbitrary<PastedNode[]> = fc
  .array(fc.record({ pick: fc.nat(), text: PASTE_TEXT }), { minLength: 2, maxLength: 6 })
  .map((specs) => {
    const depths = depthsFor(specs.map((s) => s.pick), FOREST_MAX_DEPTH);
    return nest<Slot & (typeof specs)[number], PastedNode>(
      specs.map((s, i) => ({ ...s, depth: depths[i] })),
      (s) => ({ text: s.text, children: [] }),
    );
  })
  .filter((f) => f.length > 1 || f[0].children.length > 0);

/** Choosers (row, span, boundary, depth, from, to, caret) are raw naturals;
 * the runner resolves each against what the current tree offers. */
export type Command =
  | { kind: "type"; row: number; text: string }
  | { kind: "split"; row: number; caret: number }
  | { kind: "backspace"; row: number }
  | { kind: "indent" | "outdent" | "moveUp" | "moveDown" | "subtreeUp" | "subtreeDown"; row: number }
  | { kind: "indentSel" | "outdentSel" | "selUp" | "selDown" | "deleteSel"; row: number; span: number }
  | { kind: "drop"; row: number; span: number; boundary: number; depth: number }
  | { kind: "paste"; row: number; from: number; to: number; forest: PastedNode[]; style: IndentStyle }
  | { kind: "collapse"; row: number; value: boolean }
  | { kind: "heading"; row: number; value: BlockNode["heading"] }
  | { kind: "viewType"; row: number; value: SetViewTypeOp["view_type"] }
  | { kind: "undo" } | { kind: "redo" };

const row = fc.nat();
const VIEW_TYPES: SetViewTypeOp["view_type"][] = ["document", "numbered"];

const editArbs: fc.Arbitrary<Command>[] = [
  fc.record({ kind: fc.constant("type" as const), row, text: BLOCK_TEXT }),
  fc.record({ kind: fc.constant("split" as const), row, caret: fc.nat() }),
  fc.record({ kind: fc.constant("backspace" as const), row }),
  fc.record({
    kind: fc.constantFrom("indent", "outdent", "moveUp", "moveDown", "subtreeUp", "subtreeDown"),
    row,
  }),
  fc.record({
    kind: fc.constantFrom("indentSel", "outdentSel", "selUp", "selDown", "deleteSel"),
    row, span: fc.nat(),
  }),
  fc.record({
    kind: fc.constant("drop" as const), row, span: fc.nat(), boundary: fc.nat(), depth: fc.nat(),
  }),
  fc.record({ kind: fc.constant("collapse" as const), row, value: fc.boolean() }),
  fc.record({
    kind: fc.constant("heading" as const), row,
    value: fc.constantFrom<BlockNode["heading"]>(null, 1, 2, 3),
  }),
  fc.record({ kind: fc.constant("viewType" as const), row, value: fc.constantFrom(...VIEW_TYPES) }),
];

const pasteArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant("paste" as const), row, from: fc.nat(), to: fc.nat(),
  forest: forestArb, style: styleArb,
});

// Weights out of 208: undo + redo 30 (~15%), paste 16 (~8%), the nine edit families
// share the rest evenly.
const EDIT_WEIGHT = 18; // 9 families x 18 = 162 of 208

export const commandArb: fc.Arbitrary<Command> = fc.oneof(
  ...editArbs.map((arbitrary) => ({ arbitrary, weight: EDIT_WEIGHT })),
  { arbitrary: pasteArb, weight: 16 },
  { arbitrary: fc.constant<Command>({ kind: "undo" }), weight: 15 },
  { arbitrary: fc.constant<Command>({ kind: "redo" }), weight: 15 },
);

export const sequenceArb: fc.Arbitrary<{ start: BlockNode[]; commands: Command[] }> = fc.record({
  start: treeArb,
  commands: fc.array(commandArb, { minLength: 1, maxLength: 20 }),
});
