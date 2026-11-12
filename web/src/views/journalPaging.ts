// pattern: Functional Core
// The Journal's paging state: which days are on screen, the one load in
// flight, and the error. Journal.tsx runs the fetches this state asks for and
// feeds their outcomes back in. The rules are in
// docs/architecture/contracts/frontend.md § The Journal.

export const BATCH = 5;
/** get_journal clamps `days` to this; asking for more is moot. */
export const SERVER_MAX_DAYS = 31;

/** A request for `want` days, newest first, before the date `before` (all
 * days up to today when undefined). A head load replaces the days on screen;
 * an older load appends to them. */
export interface JournalLoad {
  readonly id: number;
  readonly kind: "head" | "older";
  readonly want: number;
  readonly before: string | undefined;
}

export interface JournalPaging<T extends { readonly date: string }> {
  readonly days: readonly T[];
  /** A batch came back shorter than asked for: nothing older exists. */
  readonly done: boolean;
  /** The latest completed load's failure; null once any load succeeds. */
  readonly error: string | null;
  readonly loading: JournalLoad | null;
  readonly nextId: number;
}

export type JournalPagingEvent<T> =
  /** The sentinel came into view or "Load older days" was clicked. */
  | { readonly type: "older" }
  | { readonly type: "resync" }
  /** The component unmounted: whatever is in flight is answered by no one. */
  | { readonly type: "abandon" }
  | { readonly type: "loaded"; readonly id: number; readonly days: readonly T[] }
  | { readonly type: "failed"; readonly id: number; readonly message: string };

export function initialJournalPaging<T extends { readonly date: string }>(): JournalPaging<T> {
  return { days: [], done: false, error: null, loading: null, nextId: 0 };
}

/** The load in flight when `id` names it; null for a superseded load. */
export function loadInFlight<T extends { readonly date: string }>(
  state: JournalPaging<T>, id: number,
): JournalLoad | null {
  return state.loading?.id === id ? state.loading : null;
}

/** What sits below the days: a sentinel that loads older days as it scrolls
 * into view, a "Load older days" button after a failure, or nothing once the
 * past is exhausted. */
export function journalPager<T extends { readonly date: string }>(
  state: JournalPaging<T>,
): "sentinel" | "button" | "none" {
  if (state.done) return "none";
  return state.error !== null && state.loading === null ? "button" : "sentinel";
}

function start<T extends { readonly date: string }>(
  state: JournalPaging<T>, load: Omit<JournalLoad, "id">,
): JournalPaging<T> {
  return { ...state, loading: { ...load, id: state.nextId }, nextId: state.nextId + 1 };
}

export function journalPaging<T extends { readonly date: string }>(
  state: JournalPaging<T>, event: JournalPagingEvent<T>,
): JournalPaging<T> {
  switch (event.type) {
    case "older": {
      if (state.loading !== null || state.done) return state;
      const oldest = state.days[state.days.length - 1]?.date;
      return start(state, { kind: oldest === undefined ? "head" : "older",
                            want: BATCH, before: oldest });
    }
    case "resync":
      // The days and their cursor stay until the reload lands, so a failed
      // reload leaves "Load older days" continuing from the oldest day shown.
      return start(state, {
        kind: "head", before: undefined,
        want: Math.min(SERVER_MAX_DAYS, Math.max(BATCH, state.days.length)),
      });
    case "abandon":
      return state.loading === null ? state : { ...state, loading: null };
    case "loaded": {
      const load = loadInFlight(state, event.id);
      if (load === null) return state;
      return {
        ...state,
        days: load.kind === "head" ? event.days : [...state.days, ...event.days],
        done: event.days.length < load.want,
        error: null,
        loading: null,
      };
    }
    case "failed":
      if (loadInFlight(state, event.id) === null) return state;
      return { ...state, error: event.message, loading: null };
  }
}
