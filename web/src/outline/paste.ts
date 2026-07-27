// pattern: Functional Core
// Hierarchy-preserving outline paste (pkm-tu3a): parse clipboard text into a
// forest by indentation, then plan the exact op batch that anchors it at the
// paste location. Indent widths are compared ordinally with an indent stack,
// so 2-space, 4-space, and tab clipboards all work without configuration; an
// over-indent jump of any size is exactly one level (malformed input clamps,
// never throws).

import type { BlockNode } from "../api/payloads";
import type { BlockOp } from "../api/ops";
import { clampCaret, idxAfter, type EditResult, type FocusTarget } from "./edits";
import { applyOps, locate } from "./tree";

export interface PastedNode {
  text: string;
  children: PastedNode[];
}

const TAB_WIDTH = 4; // only matters when one clipboard mixes tabs and spaces

const BULLET_RE = /^[-*+] /;

interface MeasuredLine {
  width: number; // leading whitespace as columns, tabs expanded
  rest: string;  // the line after its indent
}

function measure(line: string): MeasuredLine {
  let width = 0;
  let i = 0;
  for (; i < line.length; i++) {
    if (line[i] === "\t") width += TAB_WIDTH;
    else if (line[i] === " ") width += 1;
    else break;
  }
  return { width, rest: line.slice(i) };
}

/** Clipboard text -> forest. Blank lines vanish; bullets are stripped only
 * when EVERY non-blank line carries one (a consistent markdown list), so
 * prose with one leading dash stays verbatim. */
export function parseOutlineForest(text: string): PastedNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
    .filter((line) => line.trim() !== "")
    .map(measure);
  if (lines.length === 0) return [];
  const stripBullets = lines.every((l) => BULLET_RE.test(l.rest));
  const roots: PastedNode[] = [];
  // Open ancestors with the width that opened each level. Pop everything at
  // or deeper than the current width: equal = sibling, between-levels =
  // sibling of the nearest shallower level (clamp), deeper = child.
  const stack: { width: number; node: PastedNode }[] = [];
  for (const { width, rest } of lines) {
    const node: PastedNode = {
      text: stripBullets ? rest.replace(BULLET_RE, "") : rest,
      children: [],
    };
    while (stack.length > 0 && stack[stack.length - 1].width >= width) {
      stack.pop();
    }
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ width, node });
  }
  return roots;
}

/** Whether onPaste should intercept: the parse yields actual structure —
 * more than one node, or a single node with children. A single content
 * line (even with a trailing newline) keeps the native textarea splice: a
 * tree-direct update_text on the focused block would fight BlockInput's
 * dirty-draft adoption, and there'd be no created block to move focus to. */
export function isOutlinePaste(text: string): boolean {
  const forest = parseOutlineForest(text);
  return forest.length > 1
    || (forest.length === 1 && forest[0].children.length > 0);
}

/** Anchor a parsed clipboard forest at the paste location. The first root's
 * text splices into the target block at [selStart, selEnd); the first root's
 * children become the target's FIRST children (expanding a collapsed
 * target); remaining roots become siblings immediately after the target.
 * Creates are emitted depth-first so every parent exists before its
 * children; consecutive-sibling order_idx values rely on applyOps's
 * insert-before shift, exactly like splitBlock. */
export function planOutlinePaste(
  blocks: BlockNode[], pageTitle: string, uid: string,
  selStart: number, selEnd: number, text: string,
  newUid: () => string,
): EditResult {
  const forest = parseOutlineForest(text);
  const found = locate(blocks, uid);
  if (!found || forest.length === 0) return { blocks, ops: [], focus: null };
  const { node, parent, siblings, index } = found;
  const [first, ...rest] = forest;

  const start = clampCaret(selStart, node.text.length);
  const end = Math.max(start, clampCaret(selEnd, node.text.length));
  const spliced = node.text.slice(0, start) + first.text + node.text.slice(end);

  const ops: BlockOp[] = [];
  if (spliced !== node.text) ops.push({ op: "update_text", uid, text: spliced });
  if (first.children.length > 0 && node.collapsed) {
    ops.push({ op: "set_collapsed", uid, collapsed: false });
  }

  let focus: FocusTarget = { uid, cursor: start + first.text.length };
  const createSubtree = (n: PastedNode, parentUid: string | null,
                         orderIdx: number): void => {
    const createdUid = newUid();
    ops.push({ op: "create", uid: createdUid, page_title: pageTitle,
               parent_uid: parentUid, order_idx: orderIdx, text: n.text });
    focus = { uid: createdUid, cursor: n.text.length };
    n.children.forEach((child, i) => createSubtree(child, createdUid, i));
  };

  const childBase = node.children[0]?.order_idx ?? 0;
  first.children.forEach((child, i) => createSubtree(child, uid, childBase + i));
  const rootBase = idxAfter(siblings, index);
  rest.forEach((root, i) => createSubtree(root, parent?.uid ?? null,
                                          rootBase + i));

  if (ops.length === 0) return { blocks, ops: [], focus: null };
  return { blocks: applyOps(blocks, ops, pageTitle), ops, focus };
}
