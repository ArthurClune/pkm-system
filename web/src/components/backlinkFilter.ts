// pattern: Functional Core
// Linked-references filtering: pure functions from loaded
// backlink groups + filter state to visible groups and candidate chips.
// Ref extraction reuses grammar/refs.ts, the fixture-pinned mirror of the
// server's refs.py, so chips agree with what the server indexes. Ref titles
// come straight from block text, so each goes through the caller's
// TitleReader (the live plain-space flag): every title compared, counted or
// held in a filter is a CanonicalTitle, the kind page titles are.

import type { CanonicalTitle } from "../api/brands";
import type { BacklinkGroup, BacklinkItem } from "../api/payloads";
import { extractRefs } from "../grammar/refs";
import type { TitleReader } from "../replica/titles";

export interface FilterState {
  include: CanonicalTitle[];
  exclude: CanonicalTitle[];
}

export const EMPTY_FILTER: FilterState = { include: [], exclude: [] };

export function isFiltering(f: FilterState): boolean {
  return f.include.length > 0 || f.exclude.length > 0;
}

// mergeGroups copies group objects but reuses item objects across
// pagination batches, so a WeakMap keyed by item survives load-all merges.
// One cache per reader: a flag flip must not serve titles canonicalized
// under the other value.
const refCaches = new WeakMap<
  TitleReader, WeakMap<BacklinkItem, ReadonlySet<CanonicalTitle>>>();

/** Every page title the item references in its own text or any ancestor
 * (breadcrumb) block: a block nested under "Papers to read #Paper" counts
 * as tagged Paper. Kinds merge: #X, [[X]] and X:: are all just "X". */
export function itemRefTitles(item: BacklinkItem,
                              read: TitleReader): ReadonlySet<CanonicalTitle> {
  let refCache = refCaches.get(read);
  if (!refCache) {
    refCache = new WeakMap();
    refCaches.set(read, refCache);
  }
  const hit = refCache.get(item);
  if (hit) return hit;
  const titles = new Set<CanonicalTitle>();
  for (const text of [item.text, ...item.breadcrumbs]) {
    for (const r of extractRefs(text).refs) titles.add(read(r.title));
  }
  refCache.set(item, titles);
  return titles;
}

/** Item visible = references ALL includes and NONE of the excludes;
 * groups left with no visible items disappear. */
export function applyFilter(groups: BacklinkGroup[], f: FilterState,
                            read: TitleReader): BacklinkGroup[] {
  if (!isFiltering(f)) return groups;
  // Entries picked under the other flag value are re-read: canonicalizing
  // is idempotent on a title already canonical under this one.
  const include = f.include.map((t) => read(t));
  const exclude = f.exclude.map((t) => read(t));
  const out: BacklinkGroup[] = [];
  for (const g of groups) {
    const items = g.items.filter((it) => {
      const refs = itemRefTitles(it, read);
      return include.every((t) => refs.has(t)) &&
             !exclude.some((t) => refs.has(t));
    });
    if (items.length > 0) out.push({ ...g, items });
  }
  return out;
}

export interface Chip {
  title: CanonicalTitle;
  count: number;
}

/** Candidate chips over the *visible* items (counts show what selecting
 * the chip would leave), count-desc then title-asc. `omit` drops the
 * current page's own title and titles already active as filters. */
export function chipCounts(visible: BacklinkGroup[],
                           omit: Iterable<CanonicalTitle>,
                           read: TitleReader): Chip[] {
  const skip = new Set([...omit].map((t) => read(t)));
  const counts = new Map<CanonicalTitle, number>();
  for (const g of visible)
    for (const it of g.items)
      for (const t of itemRefTitles(it, read))
        if (!skip.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}

/** Add `title` to `side`, moving it off the other side if present; if it
 * is already on `side`, clear it entirely (click-again-to-remove). */
export function toggleChip(f: FilterState, title: CanonicalTitle,
                           side: "include" | "exclude"): FilterState {
  const include = f.include.filter((t) => t !== title);
  const exclude = f.exclude.filter((t) => t !== title);
  if (f[side].includes(title)) return { include, exclude };
  if (side === "include") return { include: [...include, title], exclude };
  return { include, exclude: [...exclude, title] };
}
