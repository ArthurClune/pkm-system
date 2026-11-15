import { describe, expect, it } from "vitest";
import { type CellRef, stepEditor } from "../../tables/cellEditor";
import { type CellExample, GRID } from "./cellArbitraries";
import { type CellMachine, REAL, runCellExample } from "./cellRun";

const [a, b, c] = GRID as [CellRef, CellRef, CellRef];

const editsAcross: CellExample = {
  values: ["x", "y", " x", "", "", ""],
  order: [a, b, c],
  steps: [
    { kind: "open", cell: a },
    { kind: "input", draft: " y\n" },
    { kind: "tab", dir: 1 },
    { kind: "input", draft: "y " },
    { kind: "open", cell: c },
    { kind: "input", draft: "z" },
    { kind: "cancel" },
    { kind: "open", cell: c },
    { kind: "input", draft: "a\nb" },
    { kind: "tab", dir: 1 },
    { kind: "commit" },
  ],
};

describe("the cell editor property's runner", () => {
  it("passes the real machine and reaches its paths", () => {
    const run = runCellExample(editsAcross);
    expect(run.problems).toEqual([]);
    expect(run.reached).toContain("write on tab");
    expect(run.reached).toContain("skip unchanged");
    expect(run.reached).toContain("open while editing another cell");
    expect(run.reached).toContain("cancel a changed draft");
    expect(run.reached).toContain("tab to null");
    expect(run.reached).toContain("write keeps an inner newline");
    expect(run.reached).toContain("idle event ignored");
  });

  it("sees a cancel that writes", () => {
    const writes: CellMachine = {
      ...REAL,
      step: (s, e) => stepEditor(s, e.kind === "cancel" ? { kind: "commit" } : e),
    };
    const run = runCellExample(editsAcross, writes);
    expect(run.problems).toContainEqual(expect.stringMatching(/^cancel-no-write: .* \(step 6\)$/));
    expect(run.problems).toContainEqual(expect.stringMatching(/^writes: /));
  });

  it("sees an unchanged commit write", () => {
    const always: CellMachine = {
      ...REAL,
      step: (s, e) => s.kind === "editing" && e.kind === "commit"
        ? { state: { kind: "idle" }, effects: [{ kind: "write", cell: s.cell, value: s.draft.trim() }] }
        : stepEditor(s, e),
    };
    const run = runCellExample(
      { ...editsAcross, steps: [{ kind: "open", cell: b }, { kind: "commit" }] }, always);
    expect(run.problems).toContainEqual(expect.stringMatching(/^not-original: /));
  });

  it("sees a tab past the end that wraps", () => {
    const wraps: CellMachine = {
      ...REAL,
      neighbour: (order, cur, dir) => REAL.neighbour(order, cur, dir) ?? order[0] ?? null,
    };
    const run = runCellExample(editsAcross, wraps);
    expect(run.problems[0]).toMatch(/^neighbour: .* \(step 9\)$/);
  });
});
