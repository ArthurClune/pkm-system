import { describe, expect, it } from "vitest";
import type { Example } from "./arbitraries";
import { REAL, runExample, type Reducer } from "./run";

const ok = { t: "respond", pick: 0, ok: true } as const;
const fail = { t: "respond", pick: 0, ok: false } as const;

// Ten days on screen, a resync whose reload fails, then Load older days.
const failedReload: Example = {
  serverDays: 20,
  steps: [ok, { t: "older" }, ok, { t: "resync" }, fail, { t: "older" }, ok],
};

describe("the journal property's runner", () => {
  it("reaches a failed reload followed by a landed older load", () => {
    const run = runExample(failedReload);
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("resync reload fails");
    expect(run.reached).toContain("failed reload, then an older load lands");
    expect(run.reached).toContain("success clears an error");
  });

  it("sees the window collapse when a failure loses the cursor", () => {
    const losesCursor: Reducer = (state, event) => {
      if (event.type !== "older" || state.error === null) return REAL(state, event);
      return { ...REAL({ ...state, days: [] }, event), days: state.days };
    };
    const run = runExample(failedReload, losesCursor);
    expect(run.problems).toContain("never-shrinks: 10 days became 5 (step 6)");
  });

  it("calls an answer to a superseded load stale, and checks it changes nothing", () => {
    const run = runExample({ serverDays: 20, steps: [{ t: "resync" }, ok, ok] });
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("stale answer");
  });
});
