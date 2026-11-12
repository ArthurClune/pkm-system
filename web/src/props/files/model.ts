// pattern: Functional Core
// The Files list model, written from docs/architecture/contracts/frontend.md
// § The `/files` browser and the reducer's header and never from
// filesPaging.ts: which filter generation is current, whether the list on
// screen was loaded under it, what is on screen, and what a late answer may
// touch. Files are named by filter and position, so the model can tell one
// filter's list from another's.

/** Files per request. */
export const PAGE = 3;

export interface ModelMore {
  readonly gen: number;
}

export interface Model {
  /** Bumped at the keystroke and at each reload's start. */
  readonly gen: number;
  readonly phase: "loading" | "ready" | "error";
  /** The generation the list on screen was loaded under; -1 before any. */
  readonly itemsGen: number;
  /** The filter that list belongs to; -1 before any. */
  readonly itemsFilter: number;
  /** The newest `shown` files of `itemsFilter` are on screen. */
  readonly shown: number;
  readonly total: number;
  readonly more: ModelMore | null;
  readonly busy: "select-all" | "delete" | null;
  /** Selected files as positions in `itemsFilter`'s list. */
  readonly selected: ReadonlySet<number>;
  readonly notice: string | null;
}

export const MODEL_START: Model = {
  gen: 0, phase: "loading", itemsGen: -1, itemsFilter: -1, shown: 0, total: 0,
  more: null, busy: null, selected: new Set(), notice: null,
};

/** The list on screen was loaded under the current filter. */
export function isCurrentList(m: Model): boolean {
  return m.phase === "ready" && m.itemsGen === m.gen;
}

/** A keystroke or a reload's start: a new generation, the selection gone. */
export function bumped(m: Model): Model {
  return { ...m, gen: m.gen + 1, phase: "loading", selected: new Set() };
}

/** Load more starts only from the list on screen, one at a time, and not
 * beside a Select all or a delete. */
export function canMore(m: Model): boolean {
  return isCurrentList(m) && m.more === null && m.busy === null;
}

/** Select all starts only from the list on screen, with no other action in
 * flight on it. */
export function canSelectAll(m: Model): boolean {
  return isCurrentList(m) && m.busy === null && m.more === null;
}

export function reloadAnswered(
  m: Model, gen: number, answer: { filter: number; size: number } | null,
): Model {
  if (gen !== m.gen) return m;
  if (answer === null) return { ...m, phase: "error" };
  return { ...m, phase: "ready", itemsGen: gen, itemsFilter: answer.filter,
           shown: Math.min(PAGE, answer.size), total: answer.size };
}

export function moreAnswered(
  m: Model, gen: number, answer: { got: number; size: number } | null,
  failedNotice: string,
): Model {
  if (m.more?.gen !== gen) return m;
  if (gen !== m.gen) return { ...m, more: null };
  if (answer === null) return { ...m, more: null, notice: failedNotice };
  return { ...m, more: null, shown: m.shown + answer.got, total: answer.size };
}

export function selectAllAnswered(
  m: Model, gen: number, answer: { size: number } | null, failedNotice: string,
): Model {
  if (m.busy !== "select-all") return m;
  if (gen !== m.gen) return { ...m, busy: null };
  if (answer === null) return { ...m, busy: null, notice: failedNotice };
  return { ...m, busy: null, shown: answer.size,
           selected: new Set(Array.from({ length: answer.size }, (_, i) => i)) };
}

export function toggled(m: Model, position: number): Model {
  const selected = new Set(m.selected);
  if (selected.has(position)) selected.delete(position);
  else selected.add(position);
  return { ...m, selected };
}
