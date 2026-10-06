// pattern: Functional Core
// Classifies the console.warn calls a property suite makes while its injected
// faults run, and renders the one-line summary printed at the end of the
// suite. The shell that spies on console.warn is warningsCapture.ts.

export type WarnArgs = readonly unknown[];

/** One kind of warning the injected faults are expected to produce. `match`
 * returns the label the kind is tallied under, or undefined when the call is
 * not this kind. */
export interface ExpectedKind {
  readonly match: (args: WarnArgs) => string | undefined;
}

const hasPrefix = (args: WarnArgs, prefix: string): boolean =>
  typeof args[0] === "string" && args[0].startsWith(prefix);

/** The expected kinds. Anything else is reported verbatim, so add a kind here
 * only for a warning an injected fault is meant to provoke. */
export const EXPECTED_KINDS: readonly ExpectedKind[] = [
  {
    // The SQLite engine reports every failed statement through its warn hook
    // as ("sqlite3_step() rc=", code, name, "SQL =", sql). A constraint
    // failure (primary code 19) is what a replayed or duplicated insert
    // produces when the harness's retries, poisoned batches and reconnects
    // re-deliver rows the replica already holds. Any other result code is
    // not expected and stays unclassified.
    match: (args) => {
      if (!hasPrefix(args, "sqlite3_step() rc=")) return undefined;
      const code = args[1];
      const name = args[2];
      if (typeof code !== "number" || (code & 0xff) !== 19) return undefined;
      return `engine ${typeof name === "string" ? name : code}`;
    },
  },
  {
    // A window hands a title to another row while the replica's holder of
    // that title is stale (its retitle was lost or lies past the window);
    // apply.ts answers with a snapshot. Seen in the sync property.
    match: (args) =>
      hasPrefix(args, "applyChanges: stale title holder, rebootstrapping")
        ? "stale-title rebootstraps"
        : undefined,
  },
  {
    // A window the faults leave depending on rows it never shipped (a
    // child without its parent) fails the deferred FK check at COMMIT, and
    // apply.ts answers with a snapshot. Not seen in a clean run; kept
    // because the sync faults can provoke it.
    match: (args) =>
      hasPrefix(args, "applyChanges: window failed its deferred FK check, rebootstrapping")
        ? "deferred-FK rebootstraps"
        : undefined,
  },
];

export interface UnknownWarning {
  readonly context: string;
  readonly text: string;
}

export interface WarningTally {
  /** Count per expected-kind label, in first-seen order. */
  readonly counts: ReadonlyMap<string, number>;
  readonly unknown: readonly UnknownWarning[];
}

export function emptyTally(): WarningTally {
  return { counts: new Map(), unknown: [] };
}

/** One argument as console.warn would show it, on one line. */
export function renderArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

export const renderArgs = (args: WarnArgs): string => args.map(renderArg).join(" ");

/** Returns the tally with one more call counted; `context` names where the
 * call happened and is kept only for unclassified calls. */
export function classify(
  tally: WarningTally, args: WarnArgs, context: string,
  kinds: readonly ExpectedKind[] = EXPECTED_KINDS,
): WarningTally {
  for (const kind of kinds) {
    const label = kind.match(args);
    if (label === undefined) continue;
    const counts = new Map(tally.counts);
    counts.set(label, (counts.get(label) ?? 0) + 1);
    return { counts, unknown: tally.unknown };
  }
  return { counts: tally.counts, unknown: [...tally.unknown, { context, text: renderArgs(args) }] };
}

/** The suite's summary: one line of expected-kind counts, then every
 * unclassified call verbatim with its context. */
export function summarise(suite: string, tally: WarningTally): string {
  const parts = [...tally.counts].map(([label, n]) => `${n} ${label}`);
  const head = `fault warnings (${suite}): ${parts.length > 0 ? parts.join(", ") : "none"}`;
  if (tally.unknown.length === 0) return head;
  const unknown = tally.unknown.map((u) => `  UNEXPECTED [${u.context}] ${u.text}`);
  return [head, `  ${tally.unknown.length} unexpected:`, ...unknown].join("\n");
}
