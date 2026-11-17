// pattern: Functional Core
// A mounted {{query}} block's whole state, stepped by one function: its
// records and the held records a frozen view keeps (holdRecords), the view
// state (stepQueryView), and the bookkeeping that decides when to read
// /api/query for the blocks view. QueryResults runs the fetches and
// dispatches what they answer; the query view property drives the same
// step function.
//
// A Refresh releases the held rows on the next records landing for a
// newer load than the one current at the click: the request already out
// then was sent before the click and may predate the edits it should show.
// A cell edit that freezes rows while a Refresh is pending cancels it: the
// records were requested before that edit, and releasing on them would
// move or drop the row just written.
//
// A load is one records request, named by the shell's load key. The
// records may carry the groups (queryDefaults' blocks case), so a fetch
// waits for them unless the macro saves the blocks view. One /api/query is
// started per load per stay in the blocks view: leaving the view and
// returning retries a failed one, and drops the answer of one still out,
// as records that carry the groups do.
import type {
  KeyStat, QueryGroup, QueryRecordModel, QueryRecordsPayload,
} from "../api/payloads";
import type { MacroOptions } from "../grammar/macroOptions";
import { holdRecords, queryDefaults } from "./queryView";
import {
  initialQueryView, showQuery, shownView, stepQueryView, type QueryShown,
  type QueryViewEvent, type QueryViewState,
} from "./queryViewState";
import { viewFromOptions, type ViewDefaults } from "./viewState";

/** The view functions a block steps with; the property's mutants swap
 * them. */
export interface QueryMachine {
  readonly step: typeof stepQueryView;
  readonly show: typeof showQuery;
  readonly hold: typeof holdRecords;
}

export const REAL_QUERY: QueryMachine = {
  step: stepQueryView, show: showQuery, hold: holdRecords,
};

export interface QueryLoaded {
  keys: KeyStat[];
  total: number;
  defaults: ViewDefaults;
}

export interface QueryBlockState {
  options: MacroOptions;
  /** Set exactly when `qv` is: from the first records that land. */
  loaded: QueryLoaded | null;
  qv: QueryViewState | null;
  records: readonly QueryRecordModel[];
  /** Frozen rows' records the last refetch dropped, by key. */
  held: ReadonlyMap<string, QueryRecordModel>;
  error: string | null;
  /** The load whose records last landed or failed. */
  recordsFor: string | null;
  groups: QueryGroup[] | null;
  groupsError: string | null;
  /** The load `groups` answers. */
  groupsFor: string | null;
  /** The load of the /api/query out, or failed, in this stay in the
   * blocks view: the one answer the block takes, and the load it does not
   * fetch for again. Null outside that view, and once records carry the
   * groups, which are as new as any answer still out. */
  groupsTried: string | null;
  /** The load current when a pending Refresh was clicked; null when none. */
  refreshFrom: string | null;
}

export type QueryBlockEvent =
  | { kind: "options"; options: MacroOptions }
  | { kind: "recordsLanded"; load: string; payload: QueryRecordsPayload }
  | { kind: "recordsFailed"; load: string; error: string }
  | { kind: "groupsStarted"; load: string }
  | { kind: "groupsLanded"; load: string; groups: QueryGroup[] }
  | { kind: "groupsFailed"; load: string; error: string }
  /** A reader's step, Save, or a cell write's `edited`, whose snapshot the
   * shell takes from the last committed render. */
  | { kind: "view"; event: QueryViewEvent }
  /** A cell write's record as it leaves it, shown until the next load. */
  | { kind: "patch"; key: string;
      fn: (r: QueryRecordModel) => QueryRecordModel }
  /** The Refresh button; `load` is the shell's load key before it bumps the
   * generation. */
  | { kind: "refresh"; load: string };

export function initialQueryBlock(options: MacroOptions): QueryBlockState {
  return {
    options, loaded: null, qv: null, records: [], held: new Map(),
    error: null, recordsFor: null, groups: null, groupsError: null,
    groupsFor: null, groupsTried: null,
    refreshFrom: null,
  };
}

export interface QueryBlock {
  step(s: QueryBlockState, e: QueryBlockEvent): QueryBlockState;
  /** What the block shows, or null before its first records land. */
  shown(s: QueryBlockState): QueryShown | null;
  /** The shown view, or until there is one the view the macro saves. */
  wantsBlocks(s: QueryBlockState): boolean;
  /** Whether to start /api/query for `load`, the shell's current one. */
  groupsFetchDue(s: QueryBlockState, load: string): boolean;
}

export function makeQueryBlock(m: QueryMachine = REAL_QUERY): QueryBlock {
  const wantsBlocks = (s: QueryBlockState): boolean =>
    (s.qv === null ? s.options.view : shownView(s.qv, s.options)) === "blocks";

  const resaved = (s: QueryBlockState, options: MacroOptions,
                   loaded: QueryLoaded): QueryViewState => {
    const saved = viewFromOptions(options, loaded.defaults);
    return s.qv === null ? initialQueryView(saved)
      : m.step(s.qv, { kind: "loaded", saved });
  };

  function apply(s: QueryBlockState, e: QueryBlockEvent): QueryBlockState {
    switch (e.kind) {
      case "options":
        if (e.options === s.options) return s;
        return { ...s, options: e.options,
                 qv: s.loaded === null ? s.qv : resaved(s, e.options, s.loaded) };
      case "recordsLanded": {
        const p = e.payload;
        const loaded = { keys: p.keys, total: p.total,
                         defaults: queryDefaults(p) };
        const releasing = s.refreshFrom !== null && e.load !== s.refreshFrom;
        const resavedQv = resaved(s, s.options, loaded);
        const next: QueryBlockState = {
          ...s, loaded, records: p.records, error: null, recordsFor: e.load,
          qv: releasing ? m.step(resavedQv, { kind: "release" }) : resavedQv,
          held: m.hold(s.records, s.held, p.records,
                       releasing ? null : s.qv?.view.frozen ?? null),
          refreshFrom: releasing ? null : s.refreshFrom,
        };
        return p.groups === null ? next
          : { ...next, groups: p.groups, groupsFor: e.load, groupsError: null,
              groupsTried: null };
      }
      case "recordsFailed":
        return { ...s, error: e.error, recordsFor: e.load };
      case "groupsStarted":
        return { ...s, groupsTried: e.load };
      case "groupsLanded":
        return s.groupsTried === e.load
          ? { ...s, groups: e.groups, groupsFor: e.load, groupsError: null } : s;
      case "groupsFailed":
        return s.groupsTried === e.load ? { ...s, groupsError: e.error } : s;
      case "view": {
        if (s.qv === null) return s;
        const freezes = e.event.kind === "edited" && s.qv.view.frozen === null;
        return { ...s, qv: m.step(s.qv, e.event),
                 refreshFrom: freezes ? null : s.refreshFrom };
      }
      case "refresh":
        return s.refreshFrom !== null ? s : { ...s, refreshFrom: e.load };
      case "patch": {
        const was = s.held.get(e.key);
        return { ...s,
          records: s.records.map((r) => (r.key === e.key ? e.fn(r) : r)),
          held: was === undefined ? s.held
            : new Map(s.held).set(e.key, e.fn(was)) };
      }
    }
  }

  return {
    step(s, e) {
      const next = apply(s, e);
      return next.groupsTried === null || wantsBlocks(next) ? next
        : { ...next, groupsTried: null };
    },
    shown: (s) => s.loaded === null || s.qv === null ? null
      : m.show(s.qv, s.options, s.loaded.keys, s.records, s.held),
    wantsBlocks,
    groupsFetchDue: (s, load) => wantsBlocks(s) && s.groupsFor !== load
      && s.groupsTried !== load
      && (s.options.view === "blocks" || s.recordsFor === load),
  };
}

export const QUERY_BLOCK: QueryBlock = makeQueryBlock();
