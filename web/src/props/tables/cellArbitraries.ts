// pattern: Functional Core
// What the cell editor property draws: a small grid's stored values, which
// of its cells are editable, and the reader's steps. Values and drafts share
// one pool with padded twins, so a draft often equals its original, or
// differs from it by outer whitespace alone.
import fc from "fast-check";
import type { CellRef } from "../../tables/cellEditor";

const ROWS = ["r1", "r2"] as const;
const COLS = ["Author", "Published", "Format"] as const;

/** Every cell, row-major. */
export const GRID: readonly CellRef[] = ROWS.flatMap((row) => COLS.map((col) => ({ row, col })));

const TEXTS = ["", "x", " x", "x ", "y", "a\nb", " a\nb\n"] as const;

/** One reader step. The run turns `open` and `tab` into editor events,
 * reading values from its store and the next cell from `neighbourCell`. */
export type CellStep =
  | { kind: "open"; cell: CellRef }
  | { kind: "input"; draft: string }
  | { kind: "commit" }
  | { kind: "cancel" }
  | { kind: "outside" }
  | { kind: "tab"; dir: 1 | -1 };

const stepArb: fc.Arbitrary<CellStep> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("open" as const),
                                      cell: fc.constantFrom(...GRID) }) },
  { weight: 5, arbitrary: fc.record({ kind: fc.constant("input" as const),
                                      draft: fc.constantFrom(...TEXTS) }) },
  { weight: 2, arbitrary: fc.constant({ kind: "commit" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "cancel" as const }) },
  { weight: 2, arbitrary: fc.constant({ kind: "outside" as const }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("tab" as const),
                                      dir: fc.constantFrom<1 | -1>(1, -1) }) },
);

export interface CellExample {
  /** The stored value of each GRID cell, in GRID order. */
  readonly values: readonly string[];
  /** The editable cells, row-major; a cell left out can still be opened,
   * and Tab from it goes nowhere. */
  readonly order: readonly CellRef[];
  readonly steps: readonly CellStep[];
}

export const cellExampleArb: fc.Arbitrary<CellExample> = fc.record({
  values: fc.array(fc.constantFrom(...TEXTS), { minLength: GRID.length, maxLength: GRID.length }),
  order: fc.subarray([...GRID], { minLength: 1 }),
  steps: fc.array(stepArb, { maxLength: 30, size: "max" }),
});
