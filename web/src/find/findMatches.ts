// pattern: Functional Core

export type NodePos = { node: number; offset: number };
export type FindMatch = { group: number; start: NodePos; end: NodePos };
export type FindCommand = "open" | "next" | "prev";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A start sits in the node whose span contains it; an end is exclusive, so it
// sits in the node whose span it closes. Empty nodes match neither.
function locate(starts: number[], nodes: readonly string[], at: number,
  isEnd: boolean): NodePos {
  for (let node = 0; node < nodes.length; node++) {
    const from = starts[node];
    const to = from + nodes[node].length;
    if (isEnd ? from < at && at <= to : from <= at && at < to) {
      return { node, offset: at - from };
    }
  }
  throw new Error("offset outside group");
}

export function findMatches(
  groups: readonly (readonly string[])[], query: string): FindMatch[] {
  if (query === "") return [];
  const out: FindMatch[] = [];
  groups.forEach((nodes, group) => {
    const starts: number[] = [];
    let total = 0;
    for (const n of nodes) {
      starts.push(total);
      total += n.length;
    }
    const re = new RegExp(escapeRegExp(query), "giu");
    for (const m of nodes.join("").matchAll(re)) {
      out.push({
        group,
        start: locate(starts, nodes, m.index, false),
        end: locate(starts, nodes, m.index + m[0].length, true),
      });
    }
  });
  return out;
}

export function stepIndex(
  current: number | null, count: number, dir: 1 | -1): number | null {
  if (count === 0) return null;
  if (current === null) return dir === 1 ? 0 : count - 1;
  return (current + dir + count) % count;
}

export function clampIndex(
  current: number | null, count: number): number | null {
  if (count === 0) return null;
  return current !== null && current < count ? current : 0;
}

export function findCommand(e: {
  key: string; metaKey: boolean; ctrlKey: boolean;
  altKey: boolean; shiftKey: boolean }): FindCommand | null {
  if (!e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "f") return e.shiftKey ? null : "open";
  if (key === "g") return e.shiftKey ? "prev" : "next";
  return null;
}

// The match a new query starts on: the first at or below `floor` (the
// viewport's top), as browsers do, else the first. Tops are read lazily
// because each one costs a layout read.
export function firstAtOrBelow(
  tops: Iterable<number>, floor: number): number | null {
  let i = 0;
  for (const top of tops) {
    if (top >= floor) return i;
    i++;
  }
  return i === 0 ? null : 0;
}

type Edges = { top: number; bottom: number };
type Box = Edges & { left: number; right: number };

// How far to scroll so `match` sits inside `view` with `margin` to spare,
// below `bar` when the bar is over it; 0 when it is already clear.
export function revealDelta(
  match: Box, view: Edges, bar: Box | null, margin: number): number {
  const covered = bar !== null && match.left < bar.right
    && match.right > bar.left && match.top < bar.bottom
    && match.bottom > bar.top;
  const top = covered ? Math.max(view.top, bar.bottom) : view.top;
  if (match.top < top) return match.top - top - margin;
  if (match.bottom > view.bottom) return match.bottom - view.bottom + margin;
  return 0;
}
