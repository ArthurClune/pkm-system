// pattern: Imperative Shell
// Reads the harness settings `proptest/check.sh web` passes in through the
// environment (server URL, password, and optionally a fast-check seed,
// path and command replay path for replaying a failure).

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set: run the props suite through proptest/check.sh web`);
  }
  return v;
}

export const BASE_URL: string = required("PROPTEST_BASE_URL");
export const PASSWORD: string = process.env.PROPTEST_PASSWORD ?? "proptest-pw";
export const SEED: number | undefined = process.env.PROPTEST_SEED
  ? Number(process.env.PROPTEST_SEED)
  : undefined;
/** fast-check's counterexample path, to replay a failure with SEED. */
export const PATH: string | undefined = process.env.PROPTEST_PATH || undefined;
/** fast-check's command replay hint, printed with a failing command list. */
export const REPLAY_PATH: string | undefined = process.env.PROPTEST_REPLAY_PATH || undefined;
