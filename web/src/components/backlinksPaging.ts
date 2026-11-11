// pattern: Functional Core
// The Linked references section's fetch state. Two kinds of request:
//   walks   -- Show more (one batch) and the filter panel's load-all; both
//              can be in flight at once, so each result merges onto the
//              latest groups, and the section counts as loading until every
//              walk has settled.
//   refresh -- a sync-driven reload from offset 0 that replaces the groups.
//              Each refresh starts a new epoch; a result from an older epoch,
//              walk or refresh, is dropped. A walk or the panel cannot start
//              while a refresh is in flight, since either would page on from
//              groups the refresh is about to replace.
// BacklinksSection.tsx runs the walks and drives this through useReducerRef,
// so a click in the same tick as a refresh sees it.
import type { Backlinks } from "../api/payloads";
import type { BacklinkBatchState } from "./backlinkBatchWalk";
import { mergeBacklinkResult } from "./backlinkBatchWalk";
import { showBacklinkGroups } from "./groups";

export interface BacklinksPaging {
  readonly shown: BacklinkBatchState;
  /** Bumped by refreshStarted; every request carries the epoch it began in. */
  readonly epoch: number;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  /** Show more and load-all walks in flight, by id. */
  readonly walks: ReadonlySet<number>;
  readonly nextWalk: number;
  readonly walkError: string | null;
  readonly panelOpen: boolean;
}

export type BacklinksPagingEvent =
  | { readonly type: "refreshStarted" }
  | { readonly type: "refreshLoaded"; readonly epoch: number;
      readonly result: BacklinkBatchState }
  | { readonly type: "refreshFailed"; readonly epoch: number;
      readonly message: string }
  | { readonly type: "walkStarted" }
  | { readonly type: "walkLoaded"; readonly id: number;
      readonly epoch: number; readonly result: BacklinkBatchState }
  | { readonly type: "walkFailed"; readonly id: number;
      readonly epoch: number; readonly message: string }
  /** A walk that a refresh superseded between two of its batches. */
  | { readonly type: "walkDropped"; readonly id: number }
  | { readonly type: "panelOpened" }
  | { readonly type: "panelClosed" };

export function initialBacklinksPaging(initial: Backlinks): BacklinksPaging {
  return {
    shown: { groups: showBacklinkGroups(initial.groups),
             totalPages: initial.total_pages, refTexts: {} },
    epoch: 0, refreshing: false, refreshError: null,
    walks: new Set(), nextWalk: 0, walkError: null, panelOpen: false,
  };
}

export function hasMore(state: BacklinksPaging): boolean {
  return state.shown.groups.length < state.shown.totalPages;
}

export function walking(state: BacklinksPaging): boolean {
  return state.walks.size > 0;
}

function settle(state: BacklinksPaging, id: number): BacklinksPaging {
  const walks = new Set(state.walks);
  walks.delete(id);
  return { ...state, walks };
}

export function backlinksPaging(
  state: BacklinksPaging, event: BacklinksPagingEvent,
): BacklinksPaging {
  switch (event.type) {
    case "refreshStarted":
      return { ...state, epoch: state.epoch + 1, refreshing: true,
               refreshError: null };
    case "refreshLoaded":
      if (!state.refreshing || event.epoch !== state.epoch) return state;
      return { ...state, shown: event.result, refreshing: false };
    case "refreshFailed":
      if (!state.refreshing || event.epoch !== state.epoch) return state;
      return { ...state, refreshError: event.message, refreshing: false };
    case "walkStarted":
      if (state.refreshing) return state;
      return { ...state, walks: new Set(state.walks).add(state.nextWalk),
               nextWalk: state.nextWalk + 1, walkError: null };
    case "walkLoaded": {
      if (!state.walks.has(event.id)) return state;
      const settled = settle(state, event.id);
      if (event.epoch !== state.epoch) return settled;
      return { ...settled,
               shown: mergeBacklinkResult(state.shown, event.result) };
    }
    case "walkFailed": {
      if (!state.walks.has(event.id)) return state;
      const settled = settle(state, event.id);
      if (event.epoch !== state.epoch) return settled;
      return { ...settled, walkError: event.message };
    }
    case "walkDropped":
      return state.walks.has(event.id) ? settle(state, event.id) : state;
    case "panelOpened":
      if (state.refreshing || state.panelOpen) return state;
      return { ...state, panelOpen: true };
    case "panelClosed":
      return state.panelOpen ? { ...state, panelOpen: false } : state;
  }
}
