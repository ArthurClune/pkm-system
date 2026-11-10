import { describe, expect, test } from "vitest";
import { budgetReport, failureReport, replayLine } from "./gateReport";

describe("replayLine", () => {
  test("the format the drivers printed before the gate", () => {
    expect(replayLine({ seed: 42, path: "3:1:0", file: "ops/ops.prop.ts" }))
      .toBe("replay: proptest/check.sh web --seed 42 --path '3:1:0' --file ops/ops.prop.ts");
    expect(replayLine({ seed: 42, path: null, file: "journal" }))
      .toBe("replay: proptest/check.sh web --seed 42 --file journal");
  });

  test("a command list's replay path goes last", () => {
    expect(replayLine({ seed: 7, path: "1", file: "sync/sync.prop.ts", replayPath: "AAB" }))
      .toBe("replay: proptest/check.sh web --seed 7 --path '1' --file sync/sync.prop.ts" +
            " --replay-path 'AAB'");
  });
});

describe("failureReport", () => {
  const failure = {
    suite: "journal property", file: "journal", numRuns: 12, numShrinks: 3,
    interrupted: false, seed: 42, path: "11:2", body: "counterexample: x",
    error: new Error("days: lost"),
  };

  test("head, seed, path, body, error and replay, one per line", () => {
    expect(failureReport(failure)).toBe([
      "journal property failed after 12 runs and 3 shrinks",
      "seed: 42",
      "path: 11:2",
      "counterexample: x",
      "error: days: lost",
      "replay: proptest/check.sh web --seed 42 --path '11:2' --file journal",
    ].join("\n"));
  });

  test("a shrink cut off by the time limit says so", () => {
    expect(failureReport({ ...failure, interrupted: true }).split("\n")[0])
      .toBe("journal property failed after 12 runs and 3 shrinks (shrinking cut off at the" +
            " time limit: the smallest counterexample so far)");
  });

  test("a thrown non-error and a missing path", () => {
    const text = failureReport({ ...failure, path: null, error: "boom" });
    expect(text).toContain("\npath: none\n");
    expect(text).toContain("\nerror: boom\n");
  });

  test("a replay path in the shown commands reaches the replay line", () => {
    const text = failureReport({ ...failure, body: 'counterexample: 2 clients, Edit /*replayPath="AB"*/' });
    expect(text.split("\n").at(-1)).toBe(
      "replay: proptest/check.sh web --seed 42 --path '11:2' --file journal --replay-path 'AB'");
  });
});

test("budgetReport", () => {
  expect(budgetReport({ suite: "ops property", numRuns: 900, wanted: 2250, seed: 5 }))
    .toBe("ops property ran out of its time budget after 900 of 2250 runs (no failure found):" +
          " a budget problem, not a finding\nseed: 5");
});
