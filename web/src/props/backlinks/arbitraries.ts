// pattern: Functional Core
// What the Linked references property draws: how many pages link here at
// the start, and a sequence of steps one section sees. A request's start and
// its answer are separate steps, so a refresh, another walk or the panel can
// land between them, answers arrive in any order, and the server's list
// changes underneath.
import fc from "fast-check";

export type Step =
  /** Show more (one batch) or the filter panel's load-all walk. */
  | { readonly t: "walk"; readonly all: boolean }
  /** A sync event reloads the groups from offset 0. */
  | { readonly t: "refresh"; readonly limit: number }
  | { readonly t: "panelOpen" }
  | { readonly t: "panelClose" }
  /** A page stops linking here, or a new one starts. */
  | { readonly t: "drop"; readonly pick: number }
  | { readonly t: "add" }
  /** The server answers one outstanding request, chosen by `pick`. */
  | { readonly t: "respond"; readonly pick: number; readonly ok: boolean }
  /** A walk notices a refresh superseded it, between two of its batches. */
  | { readonly t: "dropWalk"; readonly pick: number };

export interface Example {
  /** Pages linking here at the start; the first batch is on screen. */
  readonly pages: number;
  readonly steps: readonly Step[];
}

const okArb = fc.oneof({ weight: 4, arbitrary: fc.constant(true) },
                       { weight: 1, arbitrary: fc.constant(false) });

export const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant("walk" as const),
                                      all: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("refresh" as const),
                                      limit: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 1, arbitrary: fc.constant({ t: "panelOpen" } as const) },
  { weight: 1, arbitrary: fc.constant({ t: "panelClose" } as const) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("drop" as const),
                                      pick: fc.nat({ max: 11 }) }) },
  { weight: 1, arbitrary: fc.constant({ t: "add" } as const) },
  { weight: 10, arbitrary: fc.record({ t: fc.constant("respond" as const),
                                       pick: fc.nat({ max: 7 }),
                                       ok: okArb }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("dropWalk" as const),
                                      pick: fc.nat({ max: 7 }) }) },
);

export const exampleArb: fc.Arbitrary<Example> = fc.record({
  pages: fc.integer({ min: 1, max: 10 }),
  steps: fc.array(stepArb, { maxLength: 60, size: "max" }),
});
