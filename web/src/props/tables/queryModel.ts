// pattern: Functional Core
// What a query block shows, written from
// docs/architecture/contracts/frontend-editor.md § The table view (the
// `showQuery` table) and never from queryViewState.ts:
// - with no rows held it shows the live view and its columns;
// - while rows are held, a view or column list the macro leaves to the
//   defaults is the one the first edit saw, and one it sets is the live
//   one;
// - a column's key comes from the current key stats, else, while rows are
//   held, from the first edit's, else it is the label;
// - held rows are the first edit's, in order; one the records lack is stale;
// - a Refresh releases the held rows when the next records land, keeps them
//   through a failed answer, and is cancelled by an edit that holds rows.
//   An answer requested before the click never lands (the stale guard), so
//   the next records to land are always ones requested since it.
// The saved and live views come from the table view model (model.ts).
import type { KeyStat, QueryRecordModel } from "../../api/payloads";
import type { MacroOptions, MacroView } from "../../grammar/macroOptions";
import type { ViewFields } from "../../tables/viewState";
import type { ViewStep } from "./arbitraries";
import { modelStep, RELEASES, type ViewModel } from "./model";

/** What the first edit since the last release saw. */
export interface Snapshot {
  readonly view: MacroView;
  readonly labels: readonly string[];
  readonly stats: readonly KeyStat[];
  readonly rows: readonly string[];
}

export interface QueryModel {
  readonly view: ViewModel;
  readonly options: MacroOptions;
  readonly keys: readonly KeyStat[];
  readonly records: readonly QueryRecordModel[];
  readonly first: Snapshot | null;
  /** A Refresh was clicked and no records have landed since. */
  readonly refreshPending: boolean;
}

export interface ExpectedColumn { readonly label: string; readonly key: string }

export interface Expected {
  readonly view: MacroView;
  readonly columns: readonly ExpectedColumn[];
  /** The held rows in order, or null when the rows follow the live view. */
  readonly rows: readonly string[] | null;
  /** Whether each field is one the hold covers. */
  readonly viewFollows: boolean;
  readonly columnsFollow: boolean;
}

/** A label's key in `stats`: by label, then as a key. */
function keyIn(stats: readonly KeyStat[], label: string): string | undefined {
  return stats.find((k) => k.label === label)?.key
    ?? stats.find((k) => k.key === label)?.key;
}

export function expected(m: QueryModel): Expected {
  const live = m.view.live;
  const first = m.first;
  const viewFollows = first !== null && m.options.view === undefined;
  const columnsFollow = first !== null && m.options.columns === undefined;
  const labels = columnsFollow ? first.labels : live.columns;
  const columns = labels.map((label) => ({
    label,
    key: keyIn(m.keys, label)
      ?? (first === null ? undefined : keyIn(first.stats, label)) ?? label,
  }));
  return {
    view: viewFollows ? first.view : live.view,
    columns, rows: first?.rows ?? null, viewFollows, columnsFollow,
  };
}

/** The snapshot an edit takes when no rows are held: what was shown, with
 * the rows on screen; it cancels a pending Refresh. A later edit keeps the
 * first one's. */
export function edited(m: QueryModel, rows: readonly string[]): QueryModel {
  if (m.first !== null) return m;
  const shown = expected(m);
  return { ...m, refreshPending: false, first: {
    view: shown.view, labels: shown.columns.map((c) => c.label),
    stats: m.keys, rows } };
}

export const refreshed = (m: QueryModel): QueryModel =>
  ({ ...m, refreshPending: true });

/** A reader's change, Reset or Save; the ones in RELEASES let the held
 * rows go. */
export function readerStep(m: QueryModel, e: ViewStep): QueryModel {
  return { ...m, view: modelStep(m.view, e),
           first: RELEASES.has(e.kind) ? null : m.first };
}

/** A refetch or a macro edit: new data and options, and the saved view
 * they give. */
export function loadedStep(m: QueryModel, saved: ViewFields,
                           data: Partial<Pick<QueryModel, "options" | "keys" | "records">>,
): QueryModel {
  return { ...m, ...data, view: modelStep(m.view, { kind: "loaded", saved }) };
}

/** Records landing: a refetch that also lets a pending Refresh release the
 * held rows. */
export function landed(m: QueryModel, saved: ViewFields,
                       data: Pick<QueryModel, "keys" | "records">): QueryModel {
  const next = loadedStep(m, saved, data);
  return m.refreshPending
    ? { ...next, first: null, refreshPending: false } : next;
}
