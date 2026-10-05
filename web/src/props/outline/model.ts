// pattern: Functional Core
// The reading-view model: what each outline command means to a reader, stated
// over the page's reading rows and the command's resolved inputs. It works on
// rows alone and never calls the outline code it checks; where the two
// disagree, the disagreement is a finding.
import type { BlockUid } from "../../api/brands";
import type { DropPosition } from "../../outline/dnd";
import type { PastedNode } from "../../outline/paste";
import { rowsDiff, structural, type Row } from "./reading";
import type { Resolved } from "./run";

export type Expected = { kind: "noop" } | { kind: "rows"; rows: Row[] };

const NOOP: Expected = { kind: "noop" };

const indexOf = (rows: readonly Row[], uid: BlockUid): number => {
  const i = rows.findIndex((r) => r.uid === uid);
  if (i < 0) throw new Error(`model: no row ${uid}`);
  return i;
};

/** One past the end of row i's subtree: row i and the following rows deeper than it. */
const subtreeEnd = (rows: readonly Row[], i: number): number => {
  let j = i + 1;
  while (j < rows.length && rows[j].depth > rows[i].depth) j++;
  return j;
};

const hasChildren = (rows: readonly Row[], i: number): boolean => subtreeEnd(rows, i) > i + 1;

/** Row i's previous sibling, or null when it is a first sibling. */
const previousSibling = (rows: readonly Row[], i: number): number | null => {
  for (let j = i - 1; j >= 0; j--) {
    if (rows[j].depth < rows[i].depth) return null;
    if (rows[j].depth === rows[i].depth) return j;
  }
  return null;
};

/** Row i's next sibling, or null when it is a last sibling. */
const nextSibling = (rows: readonly Row[], i: number): number | null => {
  const j = subtreeEnd(rows, i);
  return j < rows.length && rows[j].depth === rows[i].depth ? j : null;
};

/** Row i's parent, or null at top level. */
const parentOf = (rows: readonly Row[], i: number): number | null => {
  for (let j = i - 1; j >= 0; j--) if (rows[j].depth < rows[i].depth) return j;
  return null;
};

/** rows[start, end) moved to sit before what was rows[at]; `at` lies outside the block. */
const moveBlock = (rows: readonly Row[], start: number, end: number, at: number): Row[] => {
  const rest = [...rows.slice(0, start), ...rows.slice(end)];
  rest.splice(at > start ? at - (end - start) : at, 0, ...rows.slice(start, end));
  return rest;
};

/** A row is hidden exactly when one of its ancestors is collapsed. */
const rehide = (rows: readonly Row[]): Row[] => {
  const ancestors: Row[] = [];
  return rows.map((r) => {
    while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= r.depth) ancestors.pop();
    const row = { ...r, hidden: ancestors.some((a) => a.collapsed) };
    ancestors.push(row);
    return row;
  });
};

const fresh = (uid: BlockUid, depth: number, text: string): Row => ({
  uid, depth, text, heading: null, viewType: null, collapsed: false, hidden: false,
});

/** Selected rows with no selected ancestor, in document order. */
const rootsOf = (rows: readonly Row[], uids: readonly BlockUid[]): number[] => {
  for (const uid of uids) indexOf(rows, uid);
  const selected = new Set<BlockUid>(uids);
  const roots: number[] = [];
  const ancestors: number[] = [];
  rows.forEach((r, i) => {
    while (ancestors.length > 0 && rows[ancestors[ancestors.length - 1]].depth >= r.depth) ancestors.pop();
    if (selected.has(r.uid) && !ancestors.some((a) => selected.has(rows[a].uid))) roots.push(i);
    ancestors.push(i);
  });
  return roots;
};

/** Consecutive roots that are adjacent siblings, grouped. */
const runsOf = (rows: readonly Row[], roots: readonly number[]): number[][] => {
  const runs: number[][] = [];
  for (const i of roots) {
    const run = runs[runs.length - 1];
    if (run && nextSibling(rows, run[run.length - 1]) === i) run.push(i);
    else runs.push([i]);
  }
  return runs;
};

/** The rows as a reader sees them after the change; a change no row shows is a noop. */
const settle = (before: readonly Row[], after: readonly Row[]): Expected => {
  const rows = rehide(after);
  return rowsDiff(before, rows) === null ? NOOP : { kind: "rows", rows };
};

/** Every row of the given roots' subtrees shifted by delta, reading order unchanged. */
const shiftSubtrees = (rows: Row[], roots: readonly number[], delta: number): void => {
  for (const i of roots) {
    const end = subtreeEnd(rows, i);
    for (let j = i; j < end; j++) rows[j] = { ...rows[j], depth: rows[j].depth + delta };
  }
};

const expand = (rows: Row[], i: number): void => { rows[i] = { ...rows[i], collapsed: false }; };

function split(before: readonly Row[], uid: BlockUid, caret: number, uidOfNew: BlockUid): Expected {
  const i = indexOf(before, uid);
  const row = before[i];
  const rows = [...before];
  if (caret === 0 && row.text !== "") {
    rows.splice(i, 0, fresh(uidOfNew, row.depth, ""));
    return settle(before, rows);
  }
  rows[i] = { ...row, text: row.text.slice(0, caret) };
  const tail = row.text.slice(caret);
  if (hasChildren(before, i) && !row.collapsed) {
    rows.splice(i + 1, 0, fresh(uidOfNew, row.depth + 1, tail));
  } else {
    rows.splice(subtreeEnd(before, i), 0, fresh(uidOfNew, row.depth, tail));
  }
  return settle(before, rows);
}

function backspace(before: readonly Row[], uid: BlockUid): Expected {
  const i = indexOf(before, uid);
  if (hasChildren(before, i)) return NOOP;
  const prev = previousSibling(before, i);
  const rows = [...before];
  if (prev === null || hasChildren(before, prev)) {
    if (before[i].text !== "") return NOOP;
    rows.splice(i, 1);
    return settle(before, rows);
  }
  rows[prev] = { ...rows[prev], text: rows[prev].text + before[i].text };
  rows.splice(i, 1);
  return settle(before, rows);
}

function indent(before: readonly Row[], uids: readonly BlockUid[]): Expected {
  const runs = runsOf(before, rootsOf(before, uids));
  const parents = runs.map((run) => previousSibling(before, run[0]));
  if (runs.length === 0 || parents.some((p) => p === null)) return NOOP;
  const rows = [...before];
  shiftSubtrees(rows, runs.flat(), +1);
  for (const p of parents) if (p !== null) expand(rows, p);
  return settle(before, rows);
}

function outdent(before: readonly Row[], uids: readonly BlockUid[]): Expected {
  const runs = runsOf(before, rootsOf(before, uids));
  if (runs.length === 0 || runs.some((run) => before[run[0]].depth === 0)) return NOOP;
  const rows = [...before];
  shiftSubtrees(rows, runs.flat(), -1);
  // The siblings after a run keep their depth, so they now read as children of
  // its last root; runs are maximal, so a next sibling is never another run's root.
  for (const run of runs) {
    const last = run[run.length - 1];
    if (nextSibling(before, last) !== null) expand(rows, last);
  }
  return settle(before, rows);
}

function deleteSubtrees(before: readonly Row[], uids: readonly BlockUid[]): Expected {
  const gone = new Set<number>();
  for (const i of rootsOf(before, uids)) {
    for (let j = i; j < subtreeEnd(before, i); j++) gone.add(j);
  }
  return settle(before, before.filter((_, j) => !gone.has(j)));
}

function setField(before: readonly Row[], uid: BlockUid, field: Partial<Row>): Expected {
  const i = indexOf(before, uid);
  const rows = [...before];
  rows[i] = { ...rows[i], ...field };
  return settle(before, rows);
}

type Direction = "up" | "down";

/**
 * The run of adjacent sibling roots moved one place, or null when blocked.
 * It swaps with the sibling subtree in that direction; failing that, when it
 * may cross, it becomes the last (up) or first (down) child of its parent's
 * neighbour, at the same depth, and that neighbour is expanded, even when it
 * is itself selected.
 */
function moveRun(rows: readonly Row[], run: readonly BlockUid[], dir: Direction,
                 cross: boolean): Row[] | null {
  const first = indexOf(rows, run[0]);
  const last = indexOf(rows, run[run.length - 1]);
  const end = subtreeEnd(rows, last);
  const sibling = dir === "up" ? previousSibling(rows, first) : nextSibling(rows, last);
  if (sibling !== null) {
    return moveBlock(rows, first, end, dir === "up" ? sibling : subtreeEnd(rows, sibling));
  }
  const parent = parentOf(rows, first);
  if (!cross || parent === null) return null;
  const neighbour = dir === "up" ? previousSibling(rows, parent) : nextSibling(rows, parent);
  if (neighbour === null) return null;
  // Up: the neighbour's subtree ends where the parent starts. Down: right after the neighbour.
  const moved = moveBlock(rows, first, end, dir === "up" ? parent : neighbour + 1);
  expand(moved, indexOf(moved, rows[neighbour].uid));
  return moved;
}

function moveOne(before: readonly Row[], uid: BlockUid, dir: Direction, cross: boolean): Expected {
  const moved = moveRun(before, [uid], dir, cross);
  return moved === null ? NOOP : settle(before, moved);
}

function moveSelection(before: readonly Row[], uids: readonly BlockUid[], dir: Direction): Expected {
  const runs = runsOf(before, rootsOf(before, uids)).map((run) => run.map((i) => before[i].uid));
  if (runs.length === 0) return NOOP;
  let rows: Row[] = [...before];
  for (const run of runs) {
    const moved = moveRun(rows, run, dir, true);
    if (moved === null) return NOOP;
    rows = moved;
  }
  return settle(before, rows);
}

function drop(before: readonly Row[], uids: readonly BlockUid[], position: DropPosition): Expected {
  const dragged = new Set<number>();
  const blocks: Row[][] = [];
  for (const uid of uids) {
    const i = indexOf(before, uid);
    const end = subtreeEnd(before, i);
    const shift = position.depth - before[i].depth;
    const block: Row[] = [];
    for (let j = i; j < end; j++) {
      dragged.add(j);
      block.push({ ...before[j], depth: before[j].depth + shift });
    }
    blocks.push(block);
  }
  const rest = before.filter((_, j) => !dragged.has(j));
  // Lifting whole subtrees out leaves every other row's ancestors, so its hidden flag, as it was.
  const visible = rest.flatMap((r, j) => (r.hidden ? [] : [j]));
  const at = position.boundary < visible.length ? visible[position.boundary] : rest.length;
  const rows = [...rest.slice(0, at), ...blocks.flat(), ...rest.slice(at)];
  const same = structural(rows).join("\n") === structural(before).join("\n");
  if (same) return NOOP;
  const after = rehide(rows);
  // A legal depth never puts a dragged root under a collapsed row (allowedDepths).
  for (const uid of uids) {
    if (after[indexOf(after, uid)].hidden) throw new Error(`model: drop hides ${uid}`);
  }
  return { kind: "rows", rows: after };
}

function paste(before: readonly Row[], uid: BlockUid, from: number, to: number,
               forest: readonly PastedNode[], uids: readonly BlockUid[]): Expected {
  const [head, ...later] = forest;
  if (head === undefined) throw new Error("model: paste of an empty forest");
  const i = indexOf(before, uid);
  const row = before[i];
  let taken = 0;
  const flatten = (nodes: readonly PastedNode[], depth: number): Row[] => nodes.flatMap((n) => {
    if (taken >= uids.length) throw new Error("model: paste ran out of fresh uids");
    return [fresh(uids[taken++], depth, n.text), ...flatten(n.children, depth + 1)];
  });
  const children = flatten(head.children, row.depth + 1);
  const siblings = flatten(later, row.depth);
  if (taken !== uids.length) throw new Error("model: paste left fresh uids unused");
  const spliced: Row = {
    ...row,
    text: row.text.slice(0, from) + head.text + row.text.slice(to),
    collapsed: children.length > 0 ? false : row.collapsed,
  };
  const end = subtreeEnd(before, i);
  return settle(before, [
    ...before.slice(0, i), spliced, ...children, ...before.slice(i + 1, end),
    ...siblings, ...before.slice(end),
  ]);
}

/** A null view type reads as "document", so setting "document" on it changes nothing. */
function viewType(before: readonly Row[], uid: BlockUid, value: NonNullable<Row["viewType"]>): Expected {
  if ((before[indexOf(before, uid)].viewType ?? "document") === value) return NOOP;
  return setField(before, uid, { viewType: value });
}

/** The rows a reader should see after the command, from the rows before it. */
export function expectedRows(before: readonly Row[], r: Resolved): Expected {
  switch (r.kind) {
    case "type": return setField(before, r.uid, { text: r.text });
    case "split": return split(before, r.uid, r.caret, r.fresh);
    case "backspace": return backspace(before, r.uid);
    case "indent": return indent(before, [r.uid]);
    case "indentSel": return indent(before, r.uids);
    case "outdent": return outdent(before, [r.uid]);
    case "outdentSel": return outdent(before, r.uids);
    case "deleteSel": return deleteSubtrees(before, r.uids);
    case "collapse": return setField(before, r.uid, { collapsed: r.value });
    case "heading": return setField(before, r.uid, { heading: r.value });
    case "viewType": return viewType(before, r.uid, r.value);
    case "moveUp": return moveOne(before, r.uid, "up", false);
    case "moveDown": return moveOne(before, r.uid, "down", false);
    case "subtreeUp": return moveOne(before, r.uid, "up", true);
    case "subtreeDown": return moveOne(before, r.uid, "down", true);
    case "selUp": return moveSelection(before, r.uids, "up");
    case "selDown": return moveSelection(before, r.uids, "down");
    case "drop": return drop(before, r.uids, r.position);
    case "paste": return paste(before, r.uid, r.from, r.to, r.forest, r.fresh);
  }
}
