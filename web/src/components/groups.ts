// pattern: Functional Core
import type { BlockGroup } from "../api/payloads";

/** Merge a later pagination batch into accumulated groups: same page_id
 * extends the existing group (deduped by uid), new pages append. */
export function mergeGroups(existing: BlockGroup[],
                            incoming: BlockGroup[]): BlockGroup[] {
  const out = existing.map((g) => ({ ...g, items: [...g.items] }));
  const index = new Map(out.map((g) => [g.page_id, g]));
  for (const g of incoming) {
    const found = index.get(g.page_id);
    if (found) {
      const seen = new Set(found.items.map((i) => i.uid));
      found.items.push(...g.items.filter((i) => !seen.has(i.uid)));
    } else {
      const copy = { ...g, items: [...g.items] };
      index.set(g.page_id, copy);
      out.push(copy);
    }
  }
  return out;
}
