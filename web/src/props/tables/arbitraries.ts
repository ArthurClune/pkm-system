// pattern: Functional Core
// What the tables properties draw. The view-state property draws a saved
// view and the steps one mounted table block sees: the reader's filter,
// sort, view and column changes, cell edits, Reset, Save, refetches and
// remounts. Pools are small so steps often land back on the saved view, a
// sort click often hits the column already sorted, and a filter often
// differs from the saved one by padding alone.
import fc from "fast-check";
import type { ViewEvent, ViewFields } from "../../tables/viewState";

export const COLUMNS = ["Author", "Published", "Format"] as const;
export const ROW_IDS = ["r1", "r2", "r3", "r4"] as const;
const FILTERS = ["", "apache", " apache", "apache ", "-status:read"] as const;

const columnArb = fc.constantFrom(...COLUMNS);

export const viewFieldsArb: fc.Arbitrary<ViewFields> = fc.record({
  filter: fc.constantFrom(...FILTERS),
  sort: fc.option(fc.record({ col: columnArb, dir: fc.constantFrom("asc", "desc") }),
                  { nil: null }),
  view: fc.constantFrom("table", "cards", "blocks"),
  columns: fc.shuffledSubarray([...COLUMNS]),
});

/** Row ids on screen, in display order. */
export const visibleIdsArb: fc.Arbitrary<string[]> = fc.shuffledSubarray([...ROW_IDS]);

export type ViewStep =
  | ViewEvent
  /** A refetch that brings the saved view unchanged: the commonest load. */
  | { kind: "refetch" }
  /** The block unmounts and mounts again, as when the page is left. */
  | { kind: "remount" };

const eventArb = (kind: ViewStep["kind"]): fc.Arbitrary<ViewStep> => {
  switch (kind) {
    case "filter":
      return fc.record({ kind: fc.constant(kind), text: fc.constantFrom(...FILTERS) });
    case "sortClick":
      return fc.record({ kind: fc.constant(kind), col: columnArb });
    case "view":
      return fc.record({ kind: fc.constant(kind),
                         view: fc.constantFrom("table", "cards", "blocks") });
    case "columns":
      return fc.record({ kind: fc.constant(kind), columns: fc.shuffledSubarray([...COLUMNS]) });
    case "edited":
      return fc.record({ kind: fc.constant(kind), visibleIds: visibleIdsArb });
    case "loaded":
      return fc.record({ kind: fc.constant(kind), saved: viewFieldsArb });
    case "reset":
    case "saved":
    case "refetch":
    case "remount":
      return fc.constant({ kind });
  }
};

const WEIGHTS: Record<ViewStep["kind"], number> = {
  filter: 4, sortClick: 4, view: 2, columns: 2, edited: 4,
  reset: 2, saved: 2, loaded: 2, refetch: 2, remount: 1,
};

export const viewStepArb: fc.Arbitrary<ViewStep> = fc.oneof(
  ...Object.entries(WEIGHTS).map(([kind, weight]) =>
    ({ weight, arbitrary: eventArb(kind as ViewStep["kind"]) })),
);

export interface ViewExample {
  readonly saved: ViewFields;
  readonly steps: readonly ViewStep[];
}

export const viewExampleArb: fc.Arbitrary<ViewExample> = fc.record({
  saved: viewFieldsArb,
  // "max" draws lengths across the whole range; the default size stops
  // near ten steps, too few for an edit, a change and a refetch to meet.
  steps: fc.array(viewStepArb, { maxLength: 40, size: "max" }),
});
