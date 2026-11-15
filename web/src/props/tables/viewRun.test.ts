import { describe, expect, it } from "vitest";
import type { ViewFields } from "../../tables/viewState";
import type { ViewExample } from "./arbitraries";
import { REAL, runViewExample, type ViewMachine } from "./viewRun";

const SAVED: ViewFields = { filter: "apache", sort: null, view: "table", columns: ["Author"] };
const remote: ViewFields = { ...SAVED, view: "cards" };

const dirtyThenLoaded: ViewExample = {
  saved: SAVED,
  steps: [
    { kind: "edited", visibleIds: ["r2", "r1"] },
    { kind: "filter", text: "kafka" },
    { kind: "edited", visibleIds: ["r3"] },
    { kind: "loaded", saved: remote },
    { kind: "edited", visibleIds: ["r1"] },
    { kind: "sortClick", col: "Author" },
  ],
};

describe("the view-state property's runner", () => {
  it("passes the real machine and reaches its paths", () => {
    const run = runViewExample(dirtyThenLoaded);
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("loaded a new saved view on dirty");
    expect(run.reached).toContain("edited, then filter releases");
    expect(run.reached).toContain("second edit keeps the snapshot");
    expect(run.reached).toContain("held through loaded");
  });

  it("sees a refetch overwrite a changed live view", () => {
    const overwrites: ViewMachine = {
      ...REAL,
      step: (s, e) => e.kind === "loaded" ? { ...s, saved: e.saved, live: e.saved }
        : REAL.step(s, e),
    };
    const run = runViewExample(dirtyThenLoaded, overwrites);
    expect(run.problems[0]).toMatch(/^live: .* \(step 3\)$/);
    expect(run.problems).toContainEqual(expect.stringMatching(/^loaded-keeps-dirty: /));
  });

  it("sees a padded filter called dirty", () => {
    const raw: ViewMachine = {
      ...REAL, isDirty: (s) => s.live.filter !== s.saved.filter,
    };
    const run = runViewExample({ saved: SAVED, steps: [{ kind: "filter", text: "apache " }] }, raw);
    expect(run.problems).toEqual([expect.stringMatching(/^dirty: isDirty true/)]);
  });

  it("sees a Save that leaves the view dirty", () => {
    const ignores: ViewMachine = {
      ...REAL, step: (s, e) => e.kind === "saved" ? s : REAL.step(s, e),
    };
    const run = runViewExample(
      { saved: SAVED, steps: [{ kind: "filter", text: "kafka" }, { kind: "saved" }] },
      ignores);
    expect(run.problems).toContainEqual(expect.stringMatching(/^saved: /));
    expect(run.problems).toContainEqual("clean: still dirty after saved (step 1)");
  });
});
