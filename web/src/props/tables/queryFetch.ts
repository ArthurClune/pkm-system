// pattern: Functional Core
// The query view property's requests: what QueryResults has out, run the
// way its effects run them, and the rules of
// docs/architecture/contracts/frontend-editor.md § What a query block
// fetches, written from that table and never from queryBlock.ts. Loads
// are numbered in the order they start, so "older" is a comparison here.
// Each problem leads with the rule it breaks:
// - fetch-unwanted: an /api/query started while the blocks view is not
//   shown (before the first records, not saved);
// - fetch-early: one started before its load's records settled, which may
//   carry the groups, though the macro does not save the blocks view;
// - fetch-twice: a second one for a load in one stay in the blocks view;
// - fetch-carried: one for a load whose records carried the groups;
// - groups-replaced: an /api/query answer replaced groups that answer the
//   same or a newer load;
// - stall: with nothing out and the blocks view shown, neither this load's
//   groups nor the error of this stay's fetch for it.
import type { QueryGroup } from "../../api/payloads";
import type { QueryBlock, QueryBlockState } from "../../tables/queryBlock";

export interface Net {
  /** The current load: the last one started. */
  gen: number;
  /** The load whose records answer is out; an older one was dropped. */
  recordsOut: number | null;
  /** The /api/query out whose answer would land: the shell's stale guard
   * drops any started before it. */
  groupsOut: { gen: number; stay: number } | null;
  /** Stays in the blocks view so far, the current one included. */
  stay: number;
  /** Whether the blocks view was shown after the last step. */
  inBlocks: boolean;
  starts: Set<string>;
  settled: Set<number>;
  carried: Set<number>;
  failed: Set<number>;
  /** The load each groups array answers, as delivered. */
  answers: Map<QueryGroup[], number>;
}

export const loadOf = (gen: number): string => `load ${gen}`;

export const failText = (gen: number, stay: number): string =>
  `/api/query failed for load ${gen} in stay ${stay}`;

export function mountNet(): Net {
  return {
    gen: 0, recordsOut: 0, groupsOut: null, stay: 0, inBlocks: false,
    starts: new Set(), settled: new Set(), carried: new Set(),
    failed: new Set(), answers: new Map(),
  };
}

/** The groups effect, asked after every step rather than only when its
 * dependencies change, so a rule leaning on when React reruns it shows.
 * `wants` is whether the blocks view is shown; `saved` whether the macro
 * saves it. */
export function startDueFetches(
  block: QueryBlock, state: QueryBlockState, net: Net, wants: boolean,
  saved: boolean, problems: string[], reached: Set<string>,
): QueryBlockState {
  if (wants && !net.inBlocks) net.stay += 1;
  net.inBlocks = wants;
  let s = state;
  const load = loadOf(net.gen);
  for (let n = 0; n < 2 && block.groupsFetchDue(s, load); n += 1) {
    const at = `${net.gen} ${net.stay}`;
    if (!wants) problems.push(`fetch-unwanted: ${load}`);
    if (!net.settled.has(net.gen) && !saved) {
      problems.push(`fetch-early: ${load} before its records`);
    }
    if (net.starts.has(at)) {
      problems.push(`fetch-twice: ${load} in stay ${net.stay}`);
    }
    if (net.carried.has(net.gen)) {
      problems.push(`fetch-carried: ${load} after its records carried them`);
    }
    reached.add(net.settled.has(net.gen)
      ? "started a fetch once the records settled"
      : "started a fetch with the records for a saved blocks view");
    if (net.failed.has(net.gen)) reached.add("retried a failed fetch in a new stay");
    net.starts.add(at);
    net.groupsOut = { gen: net.gen, stay: net.stay };
    s = block.step(s, { kind: "groupsStarted", load });
  }
  return s;
}

/** Delivers the /api/query answer out, if any. */
export function answerGroups(block: QueryBlock, state: QueryBlockState,
                             net: Net, ok: boolean, problems: string[],
                             reached: Set<string>): QueryBlockState {
  const out = net.groupsOut;
  if (out === null) return state;
  net.groupsOut = null;
  const load = loadOf(out.gen);
  if (!ok) {
    net.failed.add(out.gen);
    return block.step(state, { kind: "groupsFailed", load,
                               error: failText(out.gen, out.stay) });
  }
  const groups: QueryGroup[] = [];
  net.answers.set(groups, out.gen);
  const next = block.step(state, { kind: "groupsLanded", load, groups });
  const was = state.groups === null ? undefined : net.answers.get(state.groups);
  if (next.groups === groups && was !== undefined && was >= out.gen) {
    problems.push(`groups-replaced: ${load}'s answer replaced `
      + `${loadOf(was)}'s groups`);
  }
  if (next.groups !== groups) {
    reached.add(out.gen < net.gen && was === net.gen
      ? "dropped an older load's answer under this load's groups"
      : net.carried.has(out.gen)
        ? "dropped an answer the records' groups made late"
        : "dropped an answer the reader left the blocks view for");
  }
  return next;
}

/** The stall rule, judged once nothing is out. */
export function checkStall(state: QueryBlockState, net: Net,
                           reached: Set<string>): string[] {
  if (!net.inBlocks || net.recordsOut !== null || net.groupsOut !== null) {
    return [];
  }
  const has = state.groups !== null
    && net.answers.get(state.groups) === net.gen;
  const failed = state.groupsError === failText(net.gen, net.stay);
  if (has) reached.add("settled in the blocks view with this load's groups");
  if (failed) reached.add("settled in the blocks view on a failed fetch");
  return has || failed ? [] : [`stall: ${loadOf(net.gen)} in stay `
    + `${net.stay} settled with groups for ${String(state.groups === null
      ? null : net.answers.get(state.groups))}, error ${String(state.groupsError)}`];
}
