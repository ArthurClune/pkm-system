import { describe, expect, it } from "vitest";
import { payloadOf, recordOf, type QueryExample } from "./queryArbitraries";
import { REAL_QUERY, runQueryExample, type QueryMachine } from "./queryRun";

/** Edits a table of two authored books, then a refetch answers with one
 * bare record, so its default is blocks and holds no column; then the
 * reader filters. */
const heldThroughBlocks: QueryExample = {
  options: {},
  first: payloadOf([
    recordOf("r1", [["Author", "x"], ["Published", "y"]]),
    recordOf("r2", [["Author", "y"]])]),
  steps: [
    { kind: "edit" },
    { kind: "load", payload: payloadOf([recordOf("r2", [])]) },
    { kind: "edit" },
    { kind: "filter", text: "x" },
  ],
};

describe("the query view property's runner", () => {
  it("passes the real view and reaches its paths", () => {
    const run = runQueryExample(heldThroughBlocks);
    expect(run.problems).toEqual([]);
    expect([...run.reached]).toEqual(expect.arrayContaining([
      "held the table through a load whose default is blocks",
      "held a column the load's records no longer hold",
      "held a row the load dropped",
      "keyed a held column by the first edit's stats",
      "a second edit keeps the snapshot",
      "filter releases a hold",
    ]));
  });

  it("sees a view that is not held", () => {
    const unheld: QueryMachine = {
      ...REAL_QUERY,
      show: (s, ...rest) => ({ ...REAL_QUERY.show(s, ...rest), view: s.view.live.view }),
    };
    expect(runQueryExample(heldThroughBlocks, unheld).problems)
      .toEqual(["hold-view: view blocks, model table (step 1)"]);
  });

  it("sees a refetch drop a held row", () => {
    const drops: QueryMachine = { ...REAL_QUERY, hold: () => new Map() };
    expect(runQueryExample(heldThroughBlocks, drops).problems)
      .toContainEqual(expect.stringMatching(/^hold-rows: .* \(step 1\)$/));
  });
});
