// pattern: Functional Core
// The text a failing gate property prints (gate.ts): what failed, the
// counterexample and the command that replays it.

export interface Replay {
  readonly seed: number;
  /** fast-check's counterexample path, absent before any failure. */
  readonly path: string | null;
  /** The `--file` value that selects the suite. */
  readonly file: string;
  /** A command list's own replay path (fc.commands). */
  readonly replayPath?: string;
}

export function replayLine(r: Replay): string {
  return `replay: proptest/check.sh web --seed ${r.seed}` +
    (r.path ? ` --path '${r.path}'` : "") +
    ` --file ${r.file}` +
    (r.replayPath ? ` --replay-path '${r.replayPath}'` : "");
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface Failure {
  /** "journal property": leads every message. */
  readonly suite: string;
  readonly file: string;
  readonly numRuns: number;
  readonly numShrinks: number;
  readonly interrupted: boolean;
  readonly seed: number;
  readonly path: string | null;
  /** The shown counterexample, one or more lines. */
  readonly body: string;
  readonly error: unknown;
}

/** fc.commands prints its replay path inside the command list. */
const REPLAY_PATH = /replayPath="([^"]*)"/;

export function failureReport(f: Failure): string {
  return [
    `${f.suite} failed after ${f.numRuns} runs and ${f.numShrinks} shrinks` +
      (f.interrupted ? " (shrinking cut off at the time limit: the smallest" +
                       " counterexample so far)" : ""),
    `seed: ${f.seed}`,
    `path: ${f.path ?? "none"}`,
    f.body,
    `error: ${errorText(f.error)}`,
    replayLine({ seed: f.seed, path: f.path, file: f.file,
                 replayPath: REPLAY_PATH.exec(f.body)?.[1] }),
  ].join("\n");
}

export function budgetReport(b: { suite: string; numRuns: number; wanted: number;
                                  seed: number }): string {
  return `${b.suite} ran out of its time budget after ${b.numRuns} of ${b.wanted} runs` +
    ` (no failure found): a budget problem, not a finding\nseed: ${b.seed}`;
}
