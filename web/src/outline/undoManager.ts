// pattern: Imperative Shell
// The per-tab global undo history (pkm-7q14): a module singleton, like the
// session registry it dispatches into. Entries are recorded by useOutline's
// run() and replayed through the SAME pipeline as any edit — sync.enqueue for
// durability plus applyLocal on the page's mounted session for instant
// rendering. A page with no live session still gets correct data (the queue
// and replica apply the batch); the registered navigator then brings the
// user there to see it.
import type { BlockOp } from "../api/ops";
import type { WriteTicket } from "../sync/opQueue";
import { pagePath } from "../paths";
import type { FocusTarget } from "./edits";
import { emptyHistory, recordEntry, takeRedo, takeUndo,
         type HistoryEntry, type HistoryState } from "./history";
import { peekOutlineSession } from "./outlineSessions";

export interface HistoryDispatch {
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
}

export interface OutlineHistoryHooks {
  /** Flush any pending debounced draft NOW (records its entry first). */
  flushPending(): void;
  /** Adopt a focus target after a history batch applied. */
  applyFocus(focus: FocusTarget | null): void;
}

let state: HistoryState = emptyHistory();
const hooks = new Map<string, Set<OutlineHistoryHooks>>();
let navigator: ((path: string) => void) | null = null;

export function registerOutlineHistory(
  title: string, h: OutlineHistoryHooks,
): () => void {
  let set = hooks.get(title);
  if (!set) {
    set = new Set();
    hooks.set(title, set);
  }
  set.add(h);
  return () => {
    set.delete(h);
    if (set.size === 0) hooks.delete(title);
  };
}

export function setHistoryNavigator(nav: (path: string) => void): () => void {
  navigator = nav;
  return () => {
    if (navigator === nav) navigator = null;
  };
}

export function recordHistory(entry: HistoryEntry): void {
  state = recordEntry(state, entry);
}

export function performUndo(sync: HistoryDispatch): boolean {
  flushAll(); // a pending draft becomes the newest entry, then gets undone
  const { state: next, entry } = takeUndo(state);
  state = next;
  if (!entry) return false;
  dispatch(sync, entry.inverse, entry.pageTitle, entry.focusBefore);
  return true;
}

export function performRedo(sync: HistoryDispatch): boolean {
  flushAll(); // a pending draft is a NEW op: recording it clears redo (AC)
  const { state: next, entry } = takeRedo(state);
  state = next;
  if (!entry) return false;
  dispatch(sync, entry.ops, entry.pageTitle, entry.focusAfter);
  return true;
}

/** Test seam: history is module state. */
export function resetHistory(): void {
  state = emptyHistory();
}

function flushAll(): void {
  // Only the focused outline can hold a pending draft; flushing the rest is
  // a no-op (pendingTextOps returns [] for unchanged text).
  for (const set of [...hooks.values()]) {
    for (const h of [...set]) h.flushPending();
  }
}

function dispatch(sync: HistoryDispatch, batch: BlockOp[], title: string,
                  focus: FocusTarget | null): void {
  const write = sync.enqueue([...batch], ["page", title]);
  const handle = peekOutlineSession(title);
  if (handle) {
    handle.applyLocal(write, batch);
    handle.release();
    hooks.get(title)?.forEach((h) => h.applyFocus(focus));
  } else {
    // Data is already correct (queue/replica); show the user where it landed.
    navigator?.(pagePath(title));
  }
}
