// pattern: Functional Core
// check.ts runs the letters of a group in one shared browser context, and
// the committed counts were recorded in that company, so asking for one
// letter runs its whole group.
export const CONTEXT_GROUPS = ["HW", "ABFI", "JKS", "R"];

/** The letters `--only` runs: each requested letter plus its group. A letter
 * in no group is kept, for the caller to refuse. */
export function expandOnly(csv: string): Set<string> {
  const out = new Set<string>();
  for (const letter of csv.split(",")) {
    const group = CONTEXT_GROUPS.find((g) => g.includes(letter));
    for (const l of group ?? letter) out.add(l);
  }
  return out;
}
