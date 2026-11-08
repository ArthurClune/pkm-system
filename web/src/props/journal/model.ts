// pattern: Functional Core
// The Journal paging model, written from docs/architecture/frontend.md
// § The Journal and never from journalPaging.ts: how many of the server's
// days one Journal shows, whether the past is exhausted, whether the error
// shows, and which load is in flight. Loads are named by the handle the
// reducer gave them, so the model can tell a current answer from a stale one.

/** Days per batch, and the server's clamp on `days`: both stated in the doc. */
export const BATCH = 5;
export const SERVER_MAX_DAYS = 31;

export interface ModelLoad {
  readonly id: number;
  readonly kind: "head" | "older";
  /** Days asked for. */
  readonly want: number;
}

export interface Model {
  /** The server's days on screen: always its newest `shown`. */
  readonly shown: number;
  readonly done: boolean;
  readonly error: boolean;
  readonly inFlight: ModelLoad | null;
}

export const MODEL_START: Model = { shown: 0, done: false, error: false, inFlight: null };

/** The load the sentinel or "Load older days" starts, or null when it is
 * ignored: a load is in flight or the past is exhausted. */
export function olderLoad(m: Model): Omit<ModelLoad, "id"> | null {
  if (m.inFlight !== null || m.done) return null;
  return m.shown === 0 ? { kind: "head", want: BATCH } : { kind: "older", want: BATCH };
}

/** A resync always starts a head load of the window on screen, clamped. */
export function resyncLoad(m: Model): Omit<ModelLoad, "id"> {
  return { kind: "head", want: Math.min(SERVER_MAX_DAYS, Math.max(BATCH, m.shown)) };
}

export function started(m: Model, load: ModelLoad): Model {
  return { ...m, inFlight: load };
}

/** Whether `id` answers the load in flight; any other answer is stale. */
export function isCurrent(m: Model, id: number): boolean {
  return m.inFlight?.id === id;
}

/** The current load succeeded against a server holding `serverDays` days. */
export function succeeded(m: Model, serverDays: number): Model {
  const load = m.inFlight;
  if (load === null) return m;
  const from = load.kind === "head" ? 0 : m.shown;
  const got = Math.max(0, Math.min(load.want, SERVER_MAX_DAYS, serverDays - from));
  return { shown: from + got, done: got < load.want, error: false, inFlight: null };
}

export function failed(m: Model): Model {
  return m.inFlight === null ? m : { ...m, error: true, inFlight: null };
}

export function abandoned(m: Model): Model {
  return { ...m, inFlight: null };
}

export function pager(m: Model): "sentinel" | "button" | "none" {
  if (m.done) return "none";
  return m.error && m.inFlight === null ? "button" : "sentinel";
}
