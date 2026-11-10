import { describe, expect, test } from "vitest";
import { bump, reachProblems, showTally, type Tally } from "./reach";

const tallyOf = (entries: Record<string, number>): Tally => new Map(Object.entries(entries));

describe("reachProblems", () => {
  const reach = { per: "examples", floors: { conflict: 0.1, lane: 0.02 } };

  test.each([
    ["every label over its floor", { examples: 100, conflict: 11, lane: 3 }, []],
    ["a label under its floor", { examples: 100, conflict: 9, lane: 3 },
     ["conflict: 9 of 100 examples, under the floor 0.1"]],
    ["a label exactly at its floor", { examples: 100, conflict: 10, lane: 3 },
     ["conflict: 10 of 100 examples, under the floor 0.1"]],
    ["a label never counted", { examples: 100, conflict: 11 },
     ["lane: 0 of 100 examples, under the floor 0.02"]],
    ["no examples counted", { conflict: 11, lane: 3 },
     ["examples: none counted, so no floor can be judged"]],
  ] as const)("%s", (_, entries, problems) => {
    expect(reachProblems(tallyOf(entries), reach)).toEqual(problems);
  });

  test("no floors judges nothing but the per count", () => {
    expect(reachProblems(tallyOf({ examples: 5 }), { per: "examples", floors: {} })).toEqual([]);
  });
});

describe("bump", () => {
  test("counts from zero and by n", () => {
    const t: Tally = new Map();
    bump(t, "a");
    bump(t, "a");
    bump(t, "b", 3);
    expect([...t]).toEqual([["a", 2], ["b", 3]]);
  });
});

describe("showTally", () => {
  test("rows sorted by label, each with its share of the per count", () => {
    expect(showTally("journal property", tallyOf({ z: 1, examples: 4, a: 2 }), "examples"))
      .toBe("journal property reach over 4 examples:\n  a: 2 (50.0%)\n  examples: 4 (100.0%)" +
            "\n  z: 1 (25.0%)");
  });
});
