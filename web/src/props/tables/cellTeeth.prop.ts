// pattern: Imperative Shell
// The cell editor property's teeth: wrong versions of the cell editor, each
// of which the property must catch, by a report naming the invariant the
// mutant breaks. A mutant that survives means the property cannot see that
// bug.
import { type EditorState, stepEditor } from "../../tables/cellEditor";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { type CellExample, cellExampleArb } from "./cellArbitraries";
import { type CellMachine, REAL, runCellExample } from "./cellRun";

captureFaultWarnings("table cell editor teeth");

const NUM_RUNS = 20_000;
const TIME_LIMIT_MS = 15_000;

interface Mutant extends CellMachine {
  catches: readonly string[];
}

const step = (wrong: CellMachine["step"]): CellMachine => ({ ...REAL, step: wrong });
const IDLE: EditorState = { kind: "idle" };

const MUTANTS: Record<string, Mutant> = {
  "cancel writes": {
    catches: ["cancel-no-write", "writes"],
    ...step((s, e) => stepEditor(s, e.kind === "cancel" ? { kind: "commit" } : e)),
  },
  "unchanged commit writes": {
    catches: ["not-original", "writes"],
    ...step((s, e) => s.kind === "editing" && e.kind === "commit"
      ? { state: IDLE, effects: [{ kind: "write", cell: s.cell, value: s.draft.trim() }] }
      : stepEditor(s, e)),
  },
  "open while editing drops the old draft without a write": {
    catches: ["writes"],
    ...step((s, e) => s.kind === "editing" && e.kind === "open"
      ? { state: stepEditor(IDLE, e).state, effects: [] }
      : stepEditor(s, e)),
  },
  "a write keeps the draft's padding": {
    catches: ["trimmed-draft", "writes"],
    ...step((s, e) => {
      const out = stepEditor(s, e);
      return s.kind !== "editing" ? out : {
        ...out, effects: out.effects.map((w) => ({ ...w, value: s.draft })),
      };
    }),
  },
  "Tab writes the cell twice": {
    catches: ["one-write", "writes"],
    ...step((s, e) => {
      const out = stepEditor(s, e);
      return e.kind === "tab" ? { ...out, effects: [...out.effects, ...out.effects] } : out;
    }),
  },
  "cancel leaves the cell open": {
    catches: ["idle", "state"],
    ...step((s, e) => e.kind === "cancel" ? { state: s, effects: [] } : stepEditor(s, e)),
  },
  "Tab past the last cell wraps to the first": {
    catches: ["neighbour"],
    ...REAL,
    neighbour: (order, cur, dir) => REAL.neighbour(order, cur, dir) ?? order[0] ?? null,
  },
};

expectMutantsCaught({
  suite: "table cell editor property", mutants: MUTANTS, arbs: [cellExampleArb],
  problems: async (mutant, example: CellExample) => runCellExample(example, mutant).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
});
