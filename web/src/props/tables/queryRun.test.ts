import { describe, expect, it } from "vitest";
import { payloadOf, recordOf, type QueryExample } from "./queryArbitraries";
import {
  makeQueryBlock, QUERY_BLOCK, REAL_QUERY,
} from "../../tables/queryBlock";
import { runQueryExample } from "./queryRun";

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
    const unheld = makeQueryBlock({
      ...REAL_QUERY,
      show: (s, ...rest) => ({ ...REAL_QUERY.show(s, ...rest), view: s.view.live.view }),
    });
    expect(runQueryExample(heldThroughBlocks, unheld).problems)
      .toEqual(["hold-view: view blocks, model table (step 1)"]);
  });

  it("sees a refetch drop a held row", () => {
    const drops = makeQueryBlock({ ...REAL_QUERY, hold: () => new Map() });
    expect(runQueryExample(heldThroughBlocks, drops).problems)
      .toContainEqual(expect.stringMatching(/^hold-rows: .* \(step 1\)$/));
  });

  /** Edits, clicks Refresh, and its records fail, so the rows stay held
   * until the next records land; then clicks Refresh with no rows held
   * and edits before its records land, which cancels it. */
  const refreshes: QueryExample = {
    options: {},
    first: payloadOf([recordOf("r1", [["Author", "x"]]),
                      recordOf("r2", [["Author", "y"]])]),
    steps: [
      { kind: "edit" },
      { kind: "refresh" },
      { kind: "answer", payload: null },
      { kind: "load", payload: payloadOf([recordOf("r2", [["Author", "y"]])]) },
      { kind: "refresh" },
      { kind: "edit" },
      { kind: "answer", payload: payloadOf([recordOf("r1", [["Author", "x"]])]) },
    ],
  };

  it("releases on a refresh's records, and holds through its failure", () => {
    const run = runQueryExample(refreshes);
    expect(run.problems).toEqual([]);
    expect([...run.reached]).toEqual(expect.arrayContaining([
      "held through a refresh's failed answer",
      "a refreshed load releases a hold",
      "an edit after a refresh cancels it",
    ]));
  });

  it("sees an edit after the click fail to cancel the refresh", () => {
    const uncancelled = {
      ...QUERY_BLOCK,
      step: (s: Parameters<typeof QUERY_BLOCK.step>[0],
             e: Parameters<typeof QUERY_BLOCK.step>[1]) => {
        const next = QUERY_BLOCK.step(s, e);
        return e.kind === "view" && e.event.kind === "edited"
          ? { ...next, refreshFrom: s.refreshFrom } : next;
      },
    };
    expect(runQueryExample(refreshes, uncancelled).problems)
      .toContainEqual(expect.stringMatching(/^frozen: .* \(step 6\)$/));
  });

  /** A saved blocks view starts /api/query with the records, which carry
   * the groups; the /api/query answer then lands, and the reader leaves
   * the view and returns. */
  const carriedThenLate: QueryExample = {
    options: { view: "blocks" },
    first: payloadOf([recordOf("r1", [])]),
    steps: [
      { kind: "groups", ok: true },
      { kind: "view", view: "table" },
      { kind: "view", view: "blocks" },
    ],
  };

  it("keeps the groups the records carried over a late answer", () => {
    const run = runQueryExample(carriedThenLate);
    expect(run.problems).toEqual([]);
    expect([...run.reached]).toEqual(expect.arrayContaining([
      "started a fetch with the records for a saved blocks view",
      "records carried the groups while a fetch was out",
      "dropped an answer the records' groups made late",
      "settled in the blocks view with this load's groups",
    ]));
  });

  it("sees a late answer replace the groups the records carried", () => {
    const takesAny = {
      ...QUERY_BLOCK,
      step: (s: Parameters<typeof QUERY_BLOCK.step>[0],
             e: Parameters<typeof QUERY_BLOCK.step>[1]) =>
        e.kind === "groupsLanded"
          ? { ...s, groups: e.groups, groupsFor: e.load, groupsError: null }
          : QUERY_BLOCK.step(s, e),
    };
    expect(runQueryExample(carriedThenLate, takesAny).problems).toEqual([
      "groups-replaced: load 0's answer replaced load 0's groups (step 0)"]);
  });
});
