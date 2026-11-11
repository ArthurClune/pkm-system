// pattern: Functional Core
// What the Files property draws: how many files each of three filters
// matches on the server, and a sequence of steps one Files view sees. A
// request's start and its answer are separate steps, so a keystroke, a
// reload or another click can land between them, and answers arrive in any
// order, stale ones included.
import fc from "fast-check";

export type Step =
  /** A keystroke in a filter: the generation bumps now, the reload later. */
  | { readonly t: "filter"; readonly to: number }
  /** The debounced reload fires, or Delete or a retry reloads. */
  | { readonly t: "reload" }
  | { readonly t: "more" }
  | { readonly t: "selectAll" }
  | { readonly t: "delete" }
  | { readonly t: "deleteDone" }
  /** A click on one of the cards on screen, chosen by `pick`. */
  | { readonly t: "toggle"; readonly pick: number }
  | { readonly t: "notice"; readonly text: number }
  /** The server answers one outstanding request, chosen by `pick`. */
  | { readonly t: "respond"; readonly pick: number; readonly ok: boolean };

export interface Example {
  /** Files each filter matches, by filter number. */
  readonly sizes: readonly [number, number, number];
  readonly steps: readonly Step[];
}

/** Mostly successes, so a list grows past its first page. */
const okArb = fc.oneof({ weight: 4, arbitrary: fc.constant(true) },
                       { weight: 1, arbitrary: fc.constant(false) });

export const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ t: fc.constant("filter" as const),
                                      to: fc.nat({ max: 2 }) }) },
  { weight: 3, arbitrary: fc.constant({ t: "reload" } as const) },
  { weight: 3, arbitrary: fc.constant({ t: "more" } as const) },
  { weight: 3, arbitrary: fc.constant({ t: "selectAll" } as const) },
  { weight: 1, arbitrary: fc.constant({ t: "delete" } as const) },
  { weight: 3, arbitrary: fc.constant({ t: "deleteDone" } as const) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("toggle" as const),
                                      pick: fc.nat({ max: 9 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("notice" as const),
                                      text: fc.nat({ max: 2 }) }) },
  { weight: 10, arbitrary: fc.record({ t: fc.constant("respond" as const),
                                       pick: fc.nat({ max: 7 }),
                                       ok: okArb }) },
);

const sizeArb = fc.integer({ min: 0, max: 9 });

export const exampleArb: fc.Arbitrary<Example> = fc.record({
  sizes: fc.tuple(sizeArb, sizeArb, sizeArb),
  steps: fc.array(stepArb, { maxLength: 60, size: "max" }),
});
