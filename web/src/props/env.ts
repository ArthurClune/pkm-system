// pattern: Imperative Shell
// Reads the replay settings `proptest/check.sh web` passes in through the
// environment: optionally a fast-check seed, path and command replay path for
// replaying a failure. Shared by every props suite.

export const SEED: number | undefined = process.env.PROPTEST_SEED
  ? Number(process.env.PROPTEST_SEED)
  : undefined;
/** fast-check's counterexample path, to replay a failure with SEED. */
export const PATH: string | undefined = process.env.PROPTEST_PATH || undefined;
/** fast-check's command replay hint, printed with a failing command list. */
export const REPLAY_PATH: string | undefined = process.env.PROPTEST_REPLAY_PATH || undefined;
