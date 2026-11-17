// pattern: Functional Core
// A table or query block's view: the filter, sort, view and columns its
// macro's options save, the live ones the reader has changed since, and the
// rows held in place after a cell edit. The live view survives refetches and
// is lost when the block unmounts, so this state belongs to the mounted
// block, never to the cache.
import {
  type MacroOptions, type MacroView, type SortDir,
} from "../grammar/macroOptions";
import { normaliseMacroOptions } from "../grammar/macroOptionsWrite";

export interface ViewFields {
  filter: string;
  sort: { col: string; dir: SortDir } | null;
  view: MacroView;
  columns: string[];
}

export interface ViewState {
  saved: ViewFields;
  live: ViewFields;
  /** Row ids in display order, held from the first cell edit so an edited
   * row neither moves nor vanishes until the reader changes the view;
   * null while the rows follow the live filter and sort. */
  frozen: string[] | null;
}

export type ViewEvent =
  | { kind: "filter"; text: string }
  | { kind: "sortClick"; col: string }
  | { kind: "view"; view: ViewFields["view"] }
  | { kind: "columns"; columns: string[] }
  /** A cell was written; `visibleIds` are the rows on screen, in order. */
  | { kind: "edited"; visibleIds: string[] }
  | { kind: "reset" }
  /** Refresh's records landed: held rows go, the live view stays. */
  | { kind: "release" }
  /** "Save this view" wrote the live view into the macro. */
  | { kind: "saved" }
  /** A refetch brought the macro's options, perhaps edited elsewhere. */
  | { kind: "loaded"; saved: ViewFields };

export function initialView(saved: ViewFields): ViewState {
  return { saved, live: saved, frozen: null };
}

/** The filter as the macro text stores it. */
const stored = (filter: string): string =>
  normaliseMacroOptions({ filter }).filter ?? "";

const sameSort = (a: ViewFields["sort"], b: ViewFields["sort"]): boolean =>
  a === null || b === null ? a === b : a.col === b.col && a.dir === b.dir;

const sameColumns = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

/** Equal once saved: a filter that differs only in padding saves the same
 * text, so it must not offer a Save that changes nothing. */
function sameView(a: ViewFields, b: ViewFields): boolean {
  return stored(a.filter) === stored(b.filter) && sameSort(a.sort, b.sort)
    && a.view === b.view && sameColumns(a.columns, b.columns);
}

export function isDirty(s: ViewState): boolean {
  return !sameView(s.live, s.saved);
}

function nextSort(sort: ViewFields["sort"], col: string): ViewFields["sort"] {
  if (sort === null || sort.col !== col) return { col, dir: "asc" };
  return sort.dir === "asc" ? { col, dir: "desc" } : null;
}

const changeLive = (s: ViewState, change: Partial<ViewFields>): ViewState =>
  ({ ...s, live: { ...s.live, ...change }, frozen: null });

export function stepView(s: ViewState, e: ViewEvent): ViewState {
  switch (e.kind) {
    case "filter":
      return changeLive(s, { filter: e.text });
    case "sortClick":
      return changeLive(s, { sort: nextSort(s.live.sort, e.col) });
    case "view":
      return changeLive(s, { view: e.view });
    case "columns":
      return changeLive(s, { columns: e.columns });
    case "reset":
      return { ...s, live: s.saved, frozen: null };
    case "release":
      return { ...s, frozen: null };
    case "edited":
      return s.frozen !== null ? s : { ...s, frozen: e.visibleIds };
    case "saved":
      return { ...s, saved: s.live };
    case "loaded":
      // A view nobody has touched follows the saved one, so a Save on
      // another device does not leave this one offering Reset.
      return { ...s, saved: e.saved, live: isDirty(s) ? s.live : e.saved };
  }
}

/** What a block shows with no options: the view and columns its data
 * suggests. A default is never sorted or filtered, because no option can
 * spell "no sort" or an empty filter to override one. */
export type ViewDefaults = Pick<ViewFields, "view" | "columns">;

/** The view a macro's options give, each missing option read as the
 * block's default. */
export function viewFromOptions(o: MacroOptions, defaults: ViewDefaults): ViewFields {
  return {
    filter: o.filter ?? "",
    sort: o.sort ?? null,
    view: o.view ?? defaults.view,
    columns: o.columns ?? defaults.columns,
  };
}

/** The options that save `v`: only the fields that differ from the
 * defaults. A view or column list equal to the data's default is left out
 * on purpose, so the block keeps following the data when that default
 * changes; writing `view:` every time would pin it. An empty column list
 * has no option to spell it, so it reads back as the default columns. */
export function optionsFromView(v: ViewFields, defaults: ViewDefaults): MacroOptions {
  const o: MacroOptions = {};
  if (v.view !== defaults.view) o.view = v.view;
  if (stored(v.filter) !== "") o.filter = stored(v.filter);
  if (v.sort !== null) o.sort = v.sort;
  if (!sameColumns(v.columns, defaults.columns)) o.columns = v.columns;
  return o;
}
