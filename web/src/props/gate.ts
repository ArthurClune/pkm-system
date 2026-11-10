// pattern: Imperative Shell
// The loop every gate property file shares: run the property with the
// gate's seed, path and time budget and judge the result, and register one
// teeth test per mutant. Fixed scenarios, server setup and the per-file
// constants stay in the driver files.
import fc from "fast-check";
import { expect, test } from "vitest";
import { PATH, SEED } from "./env";
import { budgetReport, failureReport } from "./gateReport";
import { bump, showTally, type Tally } from "./reach";

/** The label the gate counts once per example run. */
export const EXAMPLES = "examples";

type Arbs<Ts extends unknown[]> = { [K in keyof Ts]: fc.Arbitrary<Ts[K]> };

export interface GateProperty<Ts extends [unknown, ...unknown[]]> {
  /** "journal property": leads every message. */
  suite: string;
  /** The `--file` value in the replay line. */
  file: string;
  /** In the order fast-check draws them: a place fixes what a seed and
   * path replay, so a new arbitrary goes last. */
  arbs: Arbs<Ts>;
  /** Throws on a finding. */
  predicate: (...args: Ts) => Promise<void>;
  numRuns: number;
  /** The whole property, shrinking included. Cut off while shrinking, it
   * fails with the smallest counterexample so far; cut off before any
   * failure, it fails as a budget problem, never as a finding. */
  limitMs: number;
  /** The report body for a counterexample. */
  show: (counterexample: Ts) => string;
  /** Runs after the property, before its result is judged. */
  settle?: () => Promise<void>;
  /** Emptied before the run, so it holds only what the run's examples
   * write; the gate counts EXAMPLES into it and prints it afterwards. */
  tally?: Tally;
  showTally?: (tally: Tally) => string;
}

export async function checkGateProperty<Ts extends [unknown, ...unknown[]]>(
  p: GateProperty<Ts>,
): Promise<fc.RunDetails<Ts>> {
  const tally = p.tally;
  tally?.clear();
  const details = await fc.check(fc.asyncProperty<Ts>(...p.arbs, async (...args: Ts) => {
    if (tally) bump(tally, EXAMPLES);
    await p.predicate(...args);
  }), {
    numRuns: p.numRuns, seed: SEED, path: PATH,
    interruptAfterTimeLimit: p.limitMs, markInterruptAsFailure: false,
  });
  await p.settle?.();
  if (tally) console.log(p.showTally?.(tally) ?? showTally(p.suite, tally, EXAMPLES));
  const report = (): string => failureReport({
    suite: p.suite, file: p.file, numRuns: details.numRuns, numShrinks: details.numShrinks,
    interrupted: details.interrupted, seed: details.seed,
    path: details.counterexamplePath ?? null, error: details.errorInstance,
    body: details.counterexample === null ? "counterexample: none"
      : p.show(details.counterexample),
  });
  // A failure keeps failed set when the time limit cuts its shrinking off,
  // with the smallest counterexample so far. Cut off before any failure,
  // fast-check reports interrupted, and failed as well if no example had
  // finished, but with no counterexample: either way that is the budget.
  if (details.failed && details.counterexample !== null) fail(report());
  if (details.interrupted) {
    fail(budgetReport({ suite: p.suite, numRuns: details.numRuns, wanted: p.numRuns,
                        seed: details.seed }));
  }
  if (details.failed) fail(report());
  return details;
}

function fail(text: string): never {
  console.error(text);
  throw new Error(text);
}

/** What a property throws for a finding: one problem per line. */
class PropertyReport extends Error {}

export interface MutantCase {
  /** A catch counts only when a problem line names one of these. */
  readonly catches: readonly string[];
  /** Puts the mutant in place before its run. */
  readonly arm?: () => void | Promise<void>;
  /** Takes it out again, however the run ended. */
  readonly disarm?: () => void | Promise<void>;
}

/** Registers one test per mutant: the property, run against the mutant,
 * must fail with a problem line that `caughtBy` accepts for one of its
 * `catches`. A crash, or another invariant failing alone, is not the
 * property seeing the bug. */
export function expectMutantsCaught<Ts extends [unknown, ...unknown[]], M extends MutantCase>(p: {
  /** "journal property": test names read "the journal property catches: …". */
  suite: string;
  mutants: Readonly<Record<string, M>>;
  arbs: Arbs<Ts>;
  problems: (mutant: M, ...args: Ts) => Promise<readonly string[]>;
  numRuns: number;
  limitMs: number;
  /** By default a line names a catch by leading with "<catch>: ". */
  caughtBy?: (line: string, catches: string) => boolean;
}): void {
  const caughtBy = p.caughtBy ?? ((line, c) => line.startsWith(`${c}: `));
  for (const [name, mutant] of Object.entries(p.mutants)) {
    test(`the ${p.suite} catches: ${name}`, async () => {
      await mutant.arm?.();
      let details: fc.RunDetails<Ts>;
      try {
        details = await fc.check(fc.asyncProperty<Ts>(...p.arbs, async (...args: Ts) => {
          const problems = await p.problems(mutant, ...args);
          if (problems.length > 0) throw new PropertyReport(problems.join("\n"));
        }), {
          numRuns: p.numRuns, seed: SEED, endOnFailure: true,
          interruptAfterTimeLimit: p.limitMs,
        });
      } finally {
        await mutant.disarm?.();
      }
      const cutOff = details.interrupted
        ? ` (cut off by the ${p.limitMs / 1000}s time limit, not a full run)` : "";
      expect(details.failed, `mutant survived ${details.numRuns} runs${cutOff}` +
        ` (seed ${details.seed}): ${name}`).toBe(true);
      const error = details.errorInstance;
      if (!(error instanceof PropertyReport)) {
        throw new Error(`mutant caught by a thrown error, not a property report` +
          ` (seed ${details.seed}): ${name}: ${String(error)}`);
      }
      const lines = error.message.split("\n");
      expect(lines.some((line) => mutant.catches.some((c) => caughtBy(line, c))),
             `mutant caught, but not by ${mutant.catches.join(" or ")}` +
             ` (seed ${details.seed}): ${name}:\n${lines.join("\n")}`).toBe(true);
      console.log(`teeth: ${name}: caught after ${details.numRuns} runs` +
        ` (seed ${details.seed}, path ${details.counterexamplePath ?? "none"})`);
    }, p.limitMs + 30_000);
  }
}
