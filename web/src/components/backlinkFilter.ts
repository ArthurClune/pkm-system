// pattern: Functional Core
// Linked-references filtering (pkm-m4an): pure functions from loaded
// backlink groups + filter state to visible groups and candidate chips.
// Ref extraction reuses grammar/refs.ts, the fixture-pinned mirror of the
// server's refs.py, so chips agree with what the server indexes.

import type { BacklinkGroup, BacklinkItem } from "../api/payloads";
import { extractRefs } from "../grammar/refs";

export interface FilterState {
  include: string[];
  exclude: string[];
}

export const EMPTY_FILTER: FilterState = { include: [], exclude: [] };

export function isFiltering(f: FilterState): boolean {
  return f.include.length > 0 || f.exclude.length > 0;
}

// mergeGroups copies group objects but reuses item objects across
// pagination batches, so a WeakMap keyed by item survives load-all merges.
const refCache = new WeakMap<BacklinkItem, ReadonlySet<string>>();

/** Every page title the item references in its own text or any ancestor
 * (breadcrumb) block: a block nested under "Papers to read #Paper" counts
 * as tagged Paper. Kinds merge: #X, [[X]] and X:: are all just "X". */
export function itemRefTitles(item: BacklinkItem): ReadonlySet<string> {
  const hit = refCache.get(item);
  if (hit) return hit;
  const titles = new Set<string>();
  for (const text of [item.text, ...item.breadcrumbs]) {
    for (const r of extractRefs(text).refs) titles.add(r.title);
  }
  refCache.set(item, titles);
  return titles;
}

/** Item visible = references ALL includes and NONE of the excludes;
 * groups left with no visible items disappear. */
export function applyFilter(groups: BacklinkGroup[], f: FilterState): BacklinkGroup[] {
  if (!isFiltering(f)) return groups;
  const out: BacklinkGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((it) => {
      const refs = itemRefTitles(it);
      return f.include.every((t) => refs.has(t)) &&
             !f.exclude.some((t) => refs.has(t));
    });
    if (items.length > 0) out.push({ ...g, items });
  }
  return out;
}

export interface Chip {
  title: string;
  count: number;
}

/** Candidate chips over the *visible* items (counts show what selecting
 * the chip would leave), count-desc then title-asc. `omit` drops the
 * current page's own title and titles already active as filters. */
export function chipCounts(visible: BacklinkGroup[], omit: Iterable<string>): Chip[] {
  const skip = new Set(omit);
  const counts = new Map<string, number>();
  for (const g of visible)
    for (const it of g.items)
      for (const t of itemRefTitles(it))
        if (!skip.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** Add `title` to `side`, moving it off the other side if present; if it
 * is already on `side`, clear it entirely (click-again-to-remove). */
export function toggleChip(f: FilterState, title: string,
                           side: "include" | "exclude"): FilterState {
  const include = f.include.filter((t) => t !== title);
  const exclude = f.exclude.filter((t) => t !== title);
  if (f[side].includes(title)) return { include, exclude };
  if (side === "include") return { include: [...include, title], exclude };
  return { include, exclude: [...exclude, title] };
}
