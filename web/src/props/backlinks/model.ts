// pattern: Functional Core
// The Linked references model, written from the header of
// components/backlinksPaging.ts and docs/architecture/frontend.md and never
// from the reducer's switch: which pages are on screen, which epoch is
// current, which walks are in flight, and what each late answer may touch.
// Pages are named by number; the server's list is the runner's.

export interface Model {
  /** Page numbers on screen, in the order they arrived. */
  readonly shown: readonly number[];
  readonly totalPages: number;
  /** Bumped by each refresh's start. */
  readonly epoch: number;
  readonly refreshing: boolean;
  readonly refreshError: string | null;
  /** Walks in flight, by the id the reducer gave them. */
  readonly walks: ReadonlySet<number>;
  readonly walkError: string | null;
  readonly panelOpen: boolean;
}

export function modelStart(shown: readonly number[], totalPages: number): Model {
  return { shown, totalPages, epoch: 0, refreshing: false, refreshError: null,
           walks: new Set(), walkError: null, panelOpen: false };
}

/** Walks and the panel cannot start while a refresh is in flight. */
export function canStartWalk(m: Model): boolean {
  return !m.refreshing;
}

export function canOpenPanel(m: Model): boolean {
  return !m.refreshing && !m.panelOpen;
}

/** A walk's batch lands on the latest groups: what was on screen stays
 * where it is, and pages not yet shown follow in the batch's order. */
export function merged(shown: readonly number[], batch: readonly number[]): number[] {
  const seen = new Set(shown);
  const out = [...shown];
  for (const page of batch) {
    if (!seen.has(page)) {
      seen.add(page);
      out.push(page);
    }
  }
  return out;
}

export function withoutWalk(m: Model, id: number): Model {
  const walks = new Set(m.walks);
  walks.delete(id);
  return { ...m, walks };
}

/** The refresh of epoch `epoch` answers: a result counts only while it is
 * the one refresh in flight. */
export function refreshAnswered(
  m: Model, epoch: number,
  answer: { pages: readonly number[]; totalPages: number } | { message: string },
): Model {
  if (!m.refreshing || epoch !== m.epoch) return m;
  if ("message" in answer) {
    return { ...m, refreshError: answer.message, refreshing: false };
  }
  return { ...m, shown: answer.pages, totalPages: answer.totalPages,
           refreshing: false };
}

/** A walk's answer: it always settles, and counts only in its own epoch. */
export function walkAnswered(
  m: Model, id: number, epoch: number,
  answer: { pages: readonly number[]; totalPages: number } | { message: string },
): Model {
  if (!m.walks.has(id)) return m;
  const settled = withoutWalk(m, id);
  if (epoch !== m.epoch) return settled;
  if ("message" in answer) return { ...settled, walkError: answer.message };
  return { ...settled, shown: merged(m.shown, answer.pages),
           totalPages: answer.totalPages };
}
