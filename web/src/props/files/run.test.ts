import { describe, expect, it } from "vitest";
import type { Example } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

const ok = { t: "respond", pick: 0, ok: true } as const;

describe("the files property's runner", () => {
  it("reaches a Load more answered after the filter moved on", () => {
    const example: Example = {
      sizes: [9, 9, 9],
      steps: [ok, { t: "more" }, { t: "filter", to: 1 }, { t: "reload" },
              { t: "respond", pick: 1, ok: true }, ok, ok],
    };
    const run = runExample(example);
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("stale more answer");
    expect(run.reached).toContain("keystroke with a list action in flight");
  });

  it("refuses Select all beside a Load more", () => {
    const run = runExample({ sizes: [9, 9, 9],
                             steps: [ok, { t: "more" }, { t: "selectAll" }] });
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("Select all refused with Load more in flight");
  });

  it("sees a superseded answer land", () => {
    const lands: Reducer = (state, event) =>
      event.type === "loaded" ? REAL(state, { ...event, gen: state.filterGen })
        : REAL(state, event);
    const run = runExample({ sizes: [5, 2, 2],
                             steps: [{ t: "filter", to: 1 }, { t: "reload" }, ok, ok] },
                           lands);
    expect(run.problems.length).toBeGreaterThan(0);
  });
});
