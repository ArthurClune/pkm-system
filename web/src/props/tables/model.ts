// pattern: Functional Core
// The table view model, written from
// docs/architecture/contracts/frontend-editor.md § The table view and never
// from viewState.ts:
// - the live view starts as the saved one, survives refetches, and is lost
//   on unmount;
// - it differs from the saved view when "Save this view" would write
//   different macro text, which is when Reset and Save show;
// - Reset returns to the saved view; Save makes the live view the saved one;
// - a refetch replaces the saved view and leaves a changed live view alone,
//   while one nobody changed follows it;
// - after a cell edit the rows keep their order and visibility until the
//   filter, sort, view or columns change, Reset, or the block unmounts.
// The held rows are not state here: the run derives them from the steps
// since the last of those (`heldRows`).
import { formatMacroOptions } from "../../grammar/macroOptionsWrite";
import type { ViewFields } from "../../tables/viewState";
import type { ViewStep } from "./arbitraries";

export interface ViewModel {
  readonly saved: ViewFields;
  readonly live: ViewFields;
}

/** The macro text Save would write for `v`, every field spelled. */
export function savedText(v: ViewFields): string {
  return formatMacroOptions({
    view: v.view, filter: v.filter, sort: v.sort ?? undefined, columns: v.columns,
  });
}

export function modelDirty(m: ViewModel): boolean {
  return savedText(m.live) !== savedText(m.saved);
}

/** A column header click: unsorted or another column, then ascending, then
 * descending, then unsorted. */
const SORT_CYCLE = { none: "asc", asc: "desc", desc: "none" } as const;

function clicked(sort: ViewFields["sort"], col: string): ViewFields["sort"] {
  const now = sort !== null && sort.col === col ? sort.dir : "none";
  const next = SORT_CYCLE[now];
  return next === "none" ? null : { col, dir: next };
}

/** Steps after which the rows follow the live view again. */
export const RELEASES: ReadonlySet<ViewStep["kind"]> = new Set([
  "filter", "sortClick", "view", "columns", "reset", "release", "remount",
]);

export function modelStep(m: ViewModel, step: ViewStep): ViewModel {
  switch (step.kind) {
    case "filter":
      return { ...m, live: { ...m.live, filter: step.text } };
    case "sortClick":
      return { ...m, live: { ...m.live, sort: clicked(m.live.sort, step.col) } };
    case "view":
      return { ...m, live: { ...m.live, view: step.view } };
    case "columns":
      return { ...m, live: { ...m.live, columns: step.columns } };
    case "reset":
    case "remount":
      return { ...m, live: m.saved };
    case "release":
      return m;
    case "saved":
      return { ...m, saved: m.live };
    case "loaded":
      return { saved: step.saved, live: modelDirty(m) ? m.live : step.saved };
    case "refetch":
      return modelDirty(m) ? m : { ...m, live: m.saved };
    case "edited":
      return m;
  }
}

/** The rows held on screen after `steps`: those the first edit since the
 * last release saw, or null when no edit has come since. */
export function heldRows(steps: readonly ViewStep[]): string[] | null {
  let start = 0;
  steps.forEach((step, i) => {
    if (RELEASES.has(step.kind)) start = i + 1;
  });
  const first = steps.slice(start).find((step) => step.kind === "edited");
  return first?.kind === "edited" ? first.visibleIds : null;
}
