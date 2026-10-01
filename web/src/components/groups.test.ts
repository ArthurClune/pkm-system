// Type-safety probe for mergeGroups's page_id dedupe key. Most of this file
// is a COMPILE-time test: `pnpm typecheck` is what runs it. TypeScript
// treats an unused expect-error suppression as an error of its own, so a
// probe that stops catching its drift fails the build rather than
// silently passing.
import { expect, it } from "vitest";
import type { AssetRefGroup } from "../views/filesCore";
import { mergeGroups } from "./groups";

// AssetRefGroup (asset refs, keyed by page_title -- the search payload
// carries no page ids) must never reach mergeGroups, whose page_id key
// exists to dedupe real pages. Passing two unrelated asset groups through
// it would merge their items under a shared synthetic counter.
function assetRefGroupsCannotMerge() {
  const a: AssetRefGroup[] = [{ page_title: "Alpha", items: [] }];
  const b: AssetRefGroup[] = [{ page_title: "Beta", items: [] }];
  // @ts-expect-error AssetRefGroup has no page_id; mergeGroups must reject it
  mergeGroups(a, b);
}
void assetRefGroupsCannotMerge;

it("still merges real backlink groups by page_id and dedupes items", () => {
  const merged = mergeGroups(
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1" }] }],
    [{ page_id: 1, page_title: "A", items: [{ uid: "u1" }, { uid: "u2" }] }],
  );
  expect(merged).toEqual([
    { page_id: 1, page_title: "A", items: [{ uid: "u1" }, { uid: "u2" }] },
  ]);
});
