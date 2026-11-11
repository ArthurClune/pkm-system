// pattern: Functional Core
// What the Unlinked references property draws: a sequence of attempted
// status moves on a handful of blocks, any move from any status, so the
// lifecycle's refusals are drawn as often as its steps.
import fc from "fast-check";

export type Target = "pending" | "settled" | "delivered" | "error a" | "error b";

export interface Step {
  /** Which of the section's blocks the move is for. */
  readonly block: number;
  readonly to: Target;
}

export interface Example {
  /** Blocks the section has loaded, a listed one or not. */
  readonly loaded: number;
  readonly steps: readonly Step[];
}

export const BLOCKS = 4;

const targetArb = fc.constantFrom<Target>(
  "pending", "settled", "delivered", "error a", "error b");

export const stepArb: fc.Arbitrary<Step> = fc.record({
  block: fc.nat({ max: BLOCKS - 1 }), to: targetArb,
});

export const exampleArb: fc.Arbitrary<Example> = fc.record({
  loaded: fc.integer({ min: BLOCKS, max: BLOCKS + 6 }),
  steps: fc.array(stepArb, { maxLength: 40, size: "max" }),
});
