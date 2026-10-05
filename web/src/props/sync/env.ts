// pattern: Imperative Shell
// Reads the harness settings `proptest/check.sh web` passes in through the
// environment: the server URL and password here; the replay settings (seed,
// path, command replay path) live in ../env and are re-exported.

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is not set: run the props suite through proptest/check.sh web`);
  }
  return v;
}

export const BASE_URL: string = required("PROPTEST_BASE_URL");
export const PASSWORD: string = process.env.PROPTEST_PASSWORD ?? "proptest-pw";
export { SEED, PATH, REPLAY_PATH } from "../env";
