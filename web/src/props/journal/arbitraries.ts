// pattern: Functional Core
// What the journal property draws: how many non-empty days the server holds,
// and a sequence of steps one Journal sees. A load's start and its answer are
// separate steps, so a resync, another click or a remount can land between
// them, and answers arrive in any order, stale ones included.
import fc from "fast-check";

export type Step =
  /** The sentinel scrolled into view, or "Load older days" was clicked. */
  | { readonly t: "older" }
  | { readonly t: "resync" }
  /** The server answers one outstanding request, chosen by `pick`. */
  | { readonly t: "respond"; readonly pick: number; readonly ok: boolean }
  /** StrictMode's dev replay: unmount, then the mount effects run again. */
  | { readonly t: "replay" }
  /** A fresh Journal mounts; the old one's requests answer no one. */
  | { readonly t: "remount" };

export interface Example {
  readonly serverDays: number;
  readonly steps: readonly Step[];
}

/** Mostly successes, so a window grows past the server's cap. */
const okArb = fc.oneof({ weight: 3, arbitrary: fc.constant(true) },
                       { weight: 1, arbitrary: fc.constant(false) });

export const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.constant({ t: "older" } as const) },
  { weight: 2, arbitrary: fc.constant({ t: "resync" } as const) },
  { weight: 8, arbitrary: fc.record({ t: fc.constant("respond" as const),
                                      pick: fc.nat({ max: 7 }),
                                      ok: okArb }) },
  { weight: 1, arbitrary: fc.constant({ t: "replay" } as const) },
  { weight: 1, arbitrary: fc.constant({ t: "remount" } as const) },
);

/** Few days reach the exhausted past quickly; many pass the server's cap. */
export const exampleArb: fc.Arbitrary<Example> = fc.record({
  serverDays: fc.oneof(fc.integer({ min: 0, max: 12 }), fc.integer({ min: 13, max: 45 })),
  // fast-check's default size caps an array near ten items, too few to page
  // past the cap; "max" draws lengths across the whole range.
  steps: fc.array(stepArb, { maxLength: 80, size: "max" }),
});
