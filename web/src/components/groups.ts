// pattern: Functional Core
import type { BlockUid, CanonicalTitle, PageId } from "../api/brands";
import type { BacklinkGroup } from "../api/payloads";

/** Merge a later pagination batch into accumulated groups: same page_id
 * extends the existing group (deduped by uid), new pages append. Generic so
 * shown backlink groups (items carry crumbs) merge with the same code. */
export function mergeGroups<
  G extends { page_id: PageId; items: { uid: BlockUid }[] },
>(
    existing: G[], incoming: G[]): G[] {
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

/** A backlink as the views show it: its breadcrumb trail as texts, root
 * first, resolved from its group's `ancestor_texts` when its batch
 * arrived. Each crumb is a reference to that list's string, so a trail
 * shared by many items costs pointers, not copies. */
export interface ShownBacklinkItem {
  uid: BlockUid;
  text: string;
  crumbs: string[];
}

export interface ShownBacklinkGroup {
  page_id: PageId;
  page_title: CanonicalTitle;
  items: ShownBacklinkItem[];
}

/** What a crumb shows for an ancestor position its group's list lacks: a
 * broken payload, made visible rather than cut from the trail. */
export const MISSING_ANCESTOR_TEXT = "(missing ancestor)";

/** Resolve a payload's groups for display. Positions in `ancestors` are
 * local to their group, so a batch is resolved before it merges with
 * another; resolved items merge by uid like any other. */
export function showBacklinkGroups(
  groups: readonly BacklinkGroup[],
): ShownBacklinkGroup[] {
  return groups.map((g) => {
    const texts = g.ancestor_texts ?? [];
    return {
      page_id: g.page_id, page_title: g.page_title,
      items: g.items.map((item) => ({
        uid: item.uid, text: item.text,
        crumbs: (item.ancestors ?? []).map((at) =>
          texts[at] ?? MISSING_ANCESTOR_TEXT),
      })),
    };
  });
}
