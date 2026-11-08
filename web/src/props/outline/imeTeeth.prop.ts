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
//   does not split (`split`).
import fc from "fast-check";
import { afterEach, expect, test, vi } from "vitest";
import type * as BlockDraft from "../../outline/useBlockDraft";
import type { ImeKeydown } from "../../outline/useBlockDraft";
import { SEED } from "../env";
import { captureFaultWarnings } from "../warningsCapture";
import { runDraftExample } from "./draftHarness";
import { draftExampleArb } from "./draftModel";

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

class PropertyReport extends Error {}

afterEach(() => { mutant.current = null; });

async function expectCaught(wrong: Mutant, rule: string): Promise<void> {
  mutant.current = wrong;
  const details = await fc.check(fc.asyncProperty(draftExampleArb,
    async (example) => {
      const run = await runDraftExample(example);
      if (run.problems.length > 0) {
        throw new PropertyReport(run.problems.join("\n"));
      }
    }), {
    numRuns: NUM_RUNS, seed: SEED, endOnFailure: true,
    interruptAfterTimeLimit: TIME_LIMIT_MS,
  });
  const cutOff = details.interrupted
    ? ` (cut off by the ${TIME_LIMIT_MS / 1000}s time limit)` : "";
  expect(details.failed, `mutant survived ${details.numRuns} runs${cutOff}` +
    ` (seed ${details.seed})`).toBe(true);
  const error = details.errorInstance;
  expect(error instanceof PropertyReport, `mutant caught by a thrown error,` +
    ` not a property report (seed ${details.seed}): ${String(error)}`).toBe(true);
  const lines = (error as PropertyReport).message.split("\n");
  expect(lines.some((line) => line.includes(`}: ${rule}: `)),
         `mutant caught, but not by ${rule} (seed ${details.seed}):\n` +
         lines.join("\n")).toBe(true);
}

test("the draft property catches a policy that reads only isComposing",
     async () => {
  await expectCaught((e) => e.isComposing, "ime");
});

test("the draft property catches a policy that owns every keyCode 229",
     async () => {
  await expectCaught((e, real) => real || e.keyCode === 229, "split");
});
