// @vitest-environment node
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import propsConfig from "../vitest.props.config";
import unitConfig from "../vite.config";
import { CappedFilterArbitrary, MAX_FILTER_REJECTIONS } from "./fcFilterCap";

const rejectsAll = (): fc.Arbitrary<number> => {
  const arb = fc.integer().filter(() => false);
  // Checked first: an uncapped filter would spin the worker forever in the
  // sampling below instead of failing.
  expect(arb).toBeInstanceOf(CappedFilterArbitrary);
  return arb;
};

describe("fast-check filter cap", () => {
  it("is installed for every filter, so one that rejects all fails", () => {
    expect(() => fc.sample(rejectsAll(), 1)).toThrow(
      `filter rejected ${MAX_FILTER_REJECTIONS} generated values in a row`);
  });

  it("fails fc.assert instead of hanging the worker", () => {
    expect(() => { fc.assert(fc.property(rejectsAll(), () => true)); })
      .toThrow(/filter rejected/);
  });

  it("keeps a filter that accepts some values", () => {
    const even = fc.integer({ min: 0, max: 1000 }).filter((n) => n % 2 === 0);
    expect(even).toBeInstanceOf(CappedFilterArbitrary);
    for (const n of fc.sample(even, 200)) expect(n % 2).toBe(0);
  });

  it("narrows a type-guard filter", () => {
    const present: fc.Arbitrary<number> = fc.option(fc.integer())
      .filter((n): n is number => n !== null);
    for (const n of fc.sample(present, 50)) expect(typeof n).toBe("number");
  });

  it("shrinks only to values the predicate accepts", () => {
    const even = fc.integer({ min: 0, max: 1000 }).filter((n) => n % 2 === 0);
    const out = fc.check(fc.property(even, (n) => n < 101), { seed: 1 });
    // 428 is where fast-check's own filter stops on this seed too: integer
    // shrinking steps through odd values, which the filter drops.
    expect(out.numShrinks).toBeGreaterThan(0);
    expect(out.counterexample).toEqual([428]);
  });

  it("is a setup file of the unit and the property suite", () => {
    expect(unitConfig.test?.setupFiles).toContain("src/test-guards.ts");
    expect(propsConfig.test?.setupFiles).toContain("src/test-guards.ts");
  });
});
