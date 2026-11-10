// pattern: Functional Core
// How often a property's drawn examples reached each labelled case, and the
// floors that turn a case the generator stopped drawing into a failure.
// Floors are set by the recipe in `with_floors`' docstring
// (server/tests/hostile.py), from runs logged with PROPTEST_REACH_LOG.

/** Count per label. */
export type Tally = Map<string, number>;

/** `floors[label]` is the share of the `per` count that label must exceed. */
export interface Reach {
  readonly per: string;
  readonly floors: Readonly<Record<string, number>>;
}

export function bump(tally: Tally, label: string, n = 1): void {
  tally.set(label, (tally.get(label) ?? 0) + n);
}

/** One line per label at or under its floor; empty when reach holds. */
export function reachProblems(tally: ReadonlyMap<string, number>, reach: Reach): string[] {
  const total = tally.get(reach.per) ?? 0;
  if (total === 0) return [`${reach.per}: none counted, so no floor can be judged`];
  return Object.entries(reach.floors).flatMap(([label, share]) => {
    const n = tally.get(label) ?? 0;
    return n > total * share ? []
      : [`${label}: ${n} of ${total} ${reach.per}, under the floor ${share}`];
  });
}

/** Every label sorted, with its share of the `per` count. */
export function showTally(suite: string, tally: ReadonlyMap<string, number>,
                          per: string): string {
  const total = tally.get(per) ?? 0;
  const rows = [...tally].sort(([a], [b]) => a.localeCompare(b))
    .map(([label, n]) => `  ${label}: ${n} (${(100 * n / Math.max(1, total)).toFixed(1)}%)`);
  return `${suite} reach over ${total} ${per}:\n${rows.join("\n")}`;
}
