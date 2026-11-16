// pattern: Functional Core
// A query block's view state: the table view (stepView) and, while a cell
// edit holds the rows, the view and columns the reader saw at that edit. A
// refetch can move the data's defaults under a held view: its records may
// no longer hold a key, or hold no `::` line at all, which makes blocks the
// default. A view that follows the defaults goes on showing what the first
// edit saw, so neither a column nor the table leaves from under the reader,
// and DataTable does not commit a draft open in it.
import type { KeyStat, QueryRecordModel } from "../api/payloads";
import type { MacroOptions, MacroView } from "../grammar/macroOptions";
import {
  queryColumns, shownRows, type QueryColumn, type ShownRow,
} from "./queryView";
import {
  initialView, stepView, type ViewEvent, type ViewFields,
  type ViewState,
} from "./viewState";

/** What the block showed at the first cell edit since its rows last
 * followed the live view. `keys` are the key stats then, which name a held
 * column's key once a refetch's stats no longer do. */
export interface HeldShown {
  view: MacroView;
  columns: readonly string[];
  keys: readonly KeyStat[];
}

/** `held` is set exactly while `view.frozen` is. */
export interface QueryViewState {
  view: ViewState;
  held: HeldShown | null;
}

export type QueryViewEvent =
  | Exclude<ViewEvent, { kind: "edited" }>
  | (Extract<ViewEvent, { kind: "edited" }> & { shown: HeldShown });

export function initialQueryView(saved: ViewFields): QueryViewState {
  return { view: initialView(saved), held: null };
}

/** The snapshot is taken in the step that freezes the rows, from the
 * render the reader wrote in, so a load landing between the write and its
 * commit cannot change it. */
export function stepQueryView(s: QueryViewState,
                              e: QueryViewEvent): QueryViewState {
  const view = stepView(s.view, e);
  if (view.frozen === null) return { view, held: null };
  if (s.view.frozen === null && e.kind === "edited") {
    return { view, held: e.shown };
  }
  return { view, held: s.held };
}

export interface QueryShown {
  view: MacroView;
  columns: QueryColumn[];
  rows: ShownRow[];
  matching: number;
}

/** What a query block shows. While rows are held, a view or column list
 * the macro leaves to the data's defaults is the one the first edit saw;
 * one the macro sets shows as it is. A live view the reader changed needs
 * no test: the change released the rows, or came before the first edit,
 * which saw it. A column the current key stats do not name finds its key
 * in the held ones, so a held row's cell reads and writes its own line.
 * `heldRecords` is holdRecords' answer. */
export function showQuery(
  s: QueryViewState, options: MacroOptions, keys: readonly KeyStat[],
  records: readonly QueryRecordModel[],
  heldRecords: ReadonlyMap<string, QueryRecordModel>,
): QueryShown {
  const { view: { live, frozen }, held } = s;
  const view = shownView(s, options);
  const labels = held !== null && options.columns === undefined
    ? held.columns : live.columns;
  const columns = queryColumns(labels, keys, held?.keys ?? []);
  const { rows, matching } = shownRows(records, columns, live, frozen,
                                      heldRecords);
  return { view, columns, rows, matching };
}

/** showQuery's view, without the rows it would also work out. */
export function shownView(s: QueryViewState, options: MacroOptions): MacroView {
  return s.held !== null && options.view === undefined
    ? s.held.view : s.view.live.view;
}

/** The event a cell write steps the view with: the rows on screen, and
 * the view, columns and key stats the reader sees. */
export function editedEvent(shown: QueryShown,
                            keys: readonly KeyStat[]): QueryViewEvent {
  return {
    kind: "edited", visibleIds: shown.rows.map((r) => r.record.key),
    shown: { view: shown.view, columns: shown.columns.map((c) => c.label),
             keys },
  };
}
