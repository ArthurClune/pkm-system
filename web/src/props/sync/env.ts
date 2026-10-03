// pattern: Imperative Shell
// Reads the harness settings `proptest/check.sh web` passes in through the
// environment (server URL, password, optional fast-check seed).

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
