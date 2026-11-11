import { describe, expect, it } from "vitest";
import type { Example } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

const ok = { t: "respond", pick: 0, ok: true } as const;

describe("the backlinks property's runner", () => {
  it("reaches a walk answered after a refresh superseded it", () => {
    const example: Example = {
      pages: 6,
      steps: [{ t: "walk", all: false }, { t: "refresh", limit: 2 }, ok, ok],
    };
    const run = runExample(example);
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("walk result from an old epoch");
    expect(run.reached).toContain("old walk answers during a refresh");
  });

  it("refuses a walk and the panel while a refresh is in flight", () => {
    const run = runExample({ pages: 6, steps: [
      { t: "refresh", limit: 2 }, { t: "walk", all: true }, { t: "panelOpen" }] });
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("walk refused during a refresh");
    expect(run.reached).toContain("panel refused during a refresh");
  });

  it("sees a stale refresh result land", () => {
    const lands: Reducer = (state, event) =>
      event.type === "refreshLoaded" ? REAL(state, { ...event, epoch: state.epoch })
        : REAL(state, event);
    const run = runExample({ pages: 6, steps: [
      { t: "refresh", limit: 1 }, { t: "refresh", limit: 4 },
      { t: "drop", pick: 0 }, ok] }, lands);
    expect(run.problems.length).toBeGreaterThan(0);
  });
});
