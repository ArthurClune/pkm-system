// @vitest-environment jsdom
// pattern: Imperative Shell
// The draft property's teeth for IME composition: the editor's answer to
// "does the IME own this keydown?" (useBlockDraft's imeOwns) is swapped for a
// wrong one, and the property must name the step it broke.
// - Reading only the event's isComposing, the policy misses WebKit's
//   committing keydown (keyCode 229 after compositionend) and a keydown
//   between compositionstart and compositionend that carries no flag: an
//   Enter the IME owns splits the block (`ime`).
// - Owning every keyCode 229 keydown swallows an Enter that comes with no
//   composition just ended, as the iPad's keyboard may send it: the block
//   does not split (`split`), or stays in edit mode (`escape`).
import { vi } from "vitest";
import type * as BlockDraft from "../../outline/useBlockDraft";
import type { ImeKeydown } from "../../outline/useBlockDraft";
import { expectMutantsCaught } from "../gate";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample } from "./draftHarness";
import { draftExampleArb, type DraftExample } from "./draftModel";

type Mutant = (e: ImeKeydown, real: boolean) => boolean;

const mutant = vi.hoisted(() => ({ current: null as Mutant | null }));

vi.mock("../../outline/useBlockDraft", async (importOriginal) => {
  const real = await importOriginal<typeof BlockDraft>();
  return {
    ...real,
    useBlockDraft: (o: BlockDraft.BlockDraftOptions) => {
      const draft = real.useBlockDraft(o);
      const wrong = mutant.current;
      if (wrong === null) return draft;
      return { ...draft, imeOwns: (e: ImeKeydown) => wrong(e, draft.imeOwns(e)) };
    },
  };
});

captureFaultWarnings("outline ime teeth");

const NUM_RUNS = 400;
const TIME_LIMIT_MS = 15_000;

const policy = (wrong: Mutant, catches: readonly string[]) => ({
  catches,
  arm: () => { mutant.current = wrong; },
  disarm: () => { mutant.current = null; },
});

expectMutantsCaught({
  suite: "draft property",
  mutants: {
    "a policy that reads only isComposing": policy((e) => e.isComposing, ["ime"]),
    "a policy that owns every keyCode 229":
      policy((e, real) => real || e.keyCode === 229, ["split", "escape"]),
  },
  arbs: [draftExampleArb],
  problems: async (_, example: DraftExample) => (await runDraftExample(example)).problems,
  numRuns: NUM_RUNS, limitMs: TIME_LIMIT_MS,
  caughtBy: (line, rule) => line.includes(`}: ${rule}: `),
});
