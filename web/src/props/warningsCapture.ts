// pattern: Imperative Shell
// Hooks one props file so its console.warn calls are classified instead of
// scrolling past: call `captureFaultWarnings("<suite>")` once at the top
// level of the file. Expected kinds are tallied into a single summary line
// printed after the file's tests; unknown calls are printed verbatim in that
// summary and never fail the run. Nothing is forwarded to the real
// console.warn while the file runs, so no raw line reaches the output.
//
// console.warn is replaced directly rather than with vi.spyOn so a test's
// vi.restoreAllMocks() cannot silently end the capture.

import { afterAll, beforeAll, expect } from "vitest";
import { SEED } from "./env";
import { classify, emptyTally, summarise } from "./warnings";

export function captureFaultWarnings(suite: string): void {
  let original: typeof console.warn | undefined;
  let tally = emptyTally();

  beforeAll(() => {
    original = console.warn;
    tally = emptyTally();
    console.warn = (...args: unknown[]) => {
      const test = expect.getState().currentTestName ?? "(outside a test)";
      const seed = SEED === undefined ? "" : ` seed=${SEED}`;
      tally = classify(tally, args, `${test}${seed}`);
    };
  });

  afterAll(() => {
    if (original) console.warn = original;
    console.log(summarise(suite, tally));
  });
}
