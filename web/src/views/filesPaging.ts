// pattern: Functional Core
// The Files list's fetch state. Every list request (a reload, Load more, the
// pages Select all walks) carries the filter generation it started under,
// and its result counts only while that generation is current, so a slow
// answer for an old filter never mixes result sets, overwrites the total or
// selects files outside the visible filter. The generation is bumped at the
// keystroke (filterChanged), not when the debounced reload fires: between
// the two, items and total belong to the old filter, and Load more or Select
// all must not start from them.
//
// Load more and Select all join the generation the reload started rather
// than beginning their own, which is why this is not useStaleGuard.
// Files.tsx drives it through useReducerRef so a second click before React
// re-renders sees the first click's lock.
import type { Sha256Hex } from "../api/brands";
import type { AssetSearchItem } from "../api/payloads";

export const LOAD_MORE_FAILED = "Could not load more files.";
export const SELECT_ALL_FAILED = "Could not load the full selection.";

export interface FilesPaging {
  /** Bumped by filterChanged and reloadStarted; a reload's load id. */
  readonly filterGen: number;
  readonly phase: "loading" | "ready" | "error";
  readonly items: readonly AssetSearchItem[];
  readonly total: number;
  /** The filterGen items and total were loaded under; -1 before any. */
  readonly itemsGen: number;
  /** The Load more in flight; its result is ignored once this is cleared. */
  readonly more: { readonly gen: number } | null;
  readonly busy: "select-all" | "delete" | null;
  readonly selected: ReadonlySet<Sha256Hex>;
  readonly notice: string | null;
}

export type FilesPagingEvent =
  | { readonly type: "filterChanged" }
  | { readonly type: "reloadStarted" }
  | { readonly type: "loaded"; readonly gen: number;
      readonly items: readonly AssetSearchItem[]; readonly total: number }
  | { readonly type: "failed"; readonly gen: number }
  | { readonly type: "moreStarted" }
  | { readonly type: "moreLoaded"; readonly gen: number;
      readonly items: readonly AssetSearchItem[]; readonly total: number }
  | { readonly type: "moreFailed"; readonly gen: number }
  | { readonly type: "selectAllStarted" }
  | { readonly type: "selectAllLoaded"; readonly gen: number;
      readonly items: readonly AssetSearchItem[] }
  | { readonly type: "selectAllFailed"; readonly gen: number }
  | { readonly type: "deleteStarted" }
  | { readonly type: "deleteFinished"; readonly notice: string }
  | { readonly type: "toggled"; readonly sha: Sha256Hex }
  | { readonly type: "noticeShown"; readonly text: string };

export function initialFilesPaging(): FilesPaging {
  return {
    filterGen: 0, phase: "loading", items: [], total: 0, itemsGen: -1,
    more: null, busy: null, selected: new Set(), notice: null,
  };
}

/** The list on screen was loaded under the current filter. */
export function listIsCurrent(state: FilesPaging): boolean {
  return state.phase === "ready" && state.itemsGen === state.filterGen;
}

export function filesPaging(
  state: FilesPaging, event: FilesPagingEvent,
): FilesPaging {
  switch (event.type) {
    case "filterChanged":
    case "reloadStarted":
      return { ...state, filterGen: state.filterGen + 1, phase: "loading",
               selected: new Set() };
    case "loaded":
      if (event.gen !== state.filterGen) return state;
      return { ...state, phase: "ready", items: event.items,
               total: event.total, itemsGen: event.gen };
    case "failed":
      if (event.gen !== state.filterGen) return state;
      return { ...state, phase: "error" };
    case "moreStarted":
      if (!listIsCurrent(state) || state.more !== null) return state;
      return { ...state, more: { gen: state.filterGen } };
    case "moreLoaded":
      if (state.more?.gen !== event.gen) return state;
      if (event.gen !== state.filterGen) return { ...state, more: null };
      return { ...state, more: null, items: [...state.items, ...event.items],
               total: event.total };
    case "moreFailed":
      if (state.more?.gen !== event.gen) return state;
      if (event.gen !== state.filterGen) return { ...state, more: null };
      return { ...state, more: null, notice: LOAD_MORE_FAILED };
    case "selectAllStarted":
      if (!listIsCurrent(state) || state.busy !== null) return state;
      return { ...state, busy: "select-all" };
    case "selectAllLoaded":
      if (state.busy !== "select-all") return state;
      if (event.gen !== state.filterGen) return { ...state, busy: null };
      return { ...state, busy: null, items: event.items,
               selected: new Set(event.items.map((i) => i.sha256)) };
    case "selectAllFailed":
      if (state.busy !== "select-all") return state;
      if (event.gen !== state.filterGen) return { ...state, busy: null };
      return { ...state, busy: null, notice: SELECT_ALL_FAILED };
    case "deleteStarted":
      return state.busy === "delete" ? state : { ...state, busy: "delete" };
    case "deleteFinished":
      return { ...state, busy: null, notice: event.notice };
    case "toggled": {
      const selected = new Set(state.selected);
      if (selected.has(event.sha)) selected.delete(event.sha);
      else selected.add(event.sha);
      return { ...state, selected };
    }
    case "noticeShown":
      return state.notice === event.text
        ? state : { ...state, notice: event.text };
  }
}
