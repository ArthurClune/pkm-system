// pattern: Imperative Shell
// The per-tab global undo history: a module singleton, like the
// session registry it dispatches into. Entries are recorded by useOutline's
// run() and replayed through the SAME pipeline as any edit — sync.enqueue for
// durability plus applyLocal on the page's mounted session for instant
// rendering. A session can outlive its component (e.g. an offline edit's
// undelivered write keeps it alive after navigating away), so whether the
// effect is visible is decided by registered hooks, not session existence:
// when this page has no mounted outline (no registered hooks), the app
// navigates there so the effect is visible, even if a lingering session
// still exists to receive the data.
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import type { WriteTicket } from "../sync/opQueue";
import { pagePath } from "../paths";
import { stampBaseTextHashes } from "./baseTextHash";
import type { FocusTarget } from "./edits";
import { emptyHistory, recordEntry, resolveAnchors, takeRedo, takeUndo,
         type BatchAnchors, type HistoryEntry,
         type HistoryState } from "./history";
import { loadOutlineBlocks } from "./loadOutlineBlocks";
import { substituteMissingDaily } from "./missingPage";
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

type PageLoader = (title: string) => Promise<BlockNode[]>;
const defaultPageLoader: PageLoader =
  (title) => loadOutlineBlocks(title, substituteMissingDaily);
let loadPage: PageLoader = defaultPageLoader;
// Dispatches that had to wait for a page read, in keypress order.
let chain: Promise<void> = Promise.resolve();
let queued = 0;
let epoch = 0;

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

/** Test seam: how an unmounted page's tree is read. */
export function setHistoryPageLoader(load: PageLoader): () => void {
  loadPage = load;
  return () => {
    if (loadPage === load) loadPage = defaultPageLoader;
  };
}

/** Test seam: resolves when no queued dispatch remains. */
export async function historyIdle(): Promise<void> {
  while (queued > 0) await chain;
}

export function recordHistory(entry: HistoryEntry): void {
  state = recordEntry(state, entry).state;
}

export function performUndo(sync: HistoryDispatch): boolean {
  flushAll(); // a pending draft becomes the newest entry, then gets undone
  const { state: next, entry } = takeUndo(state);
  state = next;
  if (!entry) return false;
  dispatch(sync, entry.inverse, entry.anchors.inverse, entry.pageTitle,
           entry.focusBefore);
  return true;
}

export function performRedo(sync: HistoryDispatch): boolean {
  flushAll(); // a pending draft is a NEW op: recording it clears redo (AC)
  const { state: next, entry } = takeRedo(state);
  state = next;
  if (!entry) return false;
  dispatch(sync, entry.ops, entry.anchors.ops, entry.pageTitle,
           entry.focusAfter);
  return true;
}

/** Test seam: history is module state. */
export function resetHistory(): void {
  state = emptyHistory();
  loadPage = defaultPageLoader;
  epoch++;
  chain = Promise.resolve();
  queued = 0;
}

function flushAll(): void {
  // Only the focused outline can hold a pending draft; flushing the rest is
  // a no-op (pendingTextOps returns [] for unchanged text).
  for (const set of [...hooks.values()]) {
    for (const h of [...set]) h.flushPending();
  }
}

function dispatch(sync: HistoryDispatch, batch: BlockOp[],
                  anchors: BatchAnchors, title: string,
                  focus: FocusTarget | null): void {
  // Dispatches apply in keypress order. With nothing queued and a session for
  // the page, apply synchronously; otherwise join the chain, so a mounted
  // page's undo never overtakes an earlier undo still waiting on a page read.
  if (queued === 0) {
    const handle = peekOutlineSession(title);
    if (handle) {
      dispatchWithSession(sync, handle, batch, anchors, title, focus);
      return;
    }
  }
  const mine = epoch;
  queued++;
  chain = chain.then(async () => {
    try {
      if (mine !== epoch) return;
      const handle = peekOutlineSession(title);
      if (handle) {
        dispatchWithSession(sync, handle, batch, anchors, title, focus);
      } else {
        await dispatchUnmounted(sync, batch, anchors, title, focus);
      }
    } catch (e: unknown) {
      console.error("undo/redo dispatch failed", e);
    } finally {
      if (mine === epoch) queued--;
    }
  });
}

type SessionHandle = NonNullable<ReturnType<typeof peekOutlineSession>>;

function dispatchWithSession(sync: HistoryDispatch, handle: SessionHandle,
                             batch: BlockOp[], anchors: BatchAnchors,
                             title: string, focus: FocusTarget | null): void {
  // The tree must be read BEFORE enqueueing: the hash must be taken against the
  // tree as it is now, not as it was when the entry was recorded, or a replay
  // after any later edit would carry a stale hash and land a spurious
  // daily-note [[conflict]] header. Placements are re-keyed against the same
  // tree, before stamping, so the hashes cover the ops that actually ship
  // (history.ts states the anchor rule).
  //
  // try/finally because the handle is acquired before sync.enqueue, which
  // throws on a disposed queue (opQueue.ts); a leaked refcount pins the
  // session for the rest of the tab's life.
  try {
    const live = handle.getSnapshot().blocks;
    const wireOps = stampBaseTextHashes(
      live, title, resolveAnchors(live, title, batch, anchors));
    const write = sync.enqueue(wireOps, ["page", title]);
    handle.applyLocal(write, wireOps);
  } finally {
    handle.release();
  }
  settle(title, focus);
}

async function dispatchUnmounted(sync: HistoryDispatch, batch: BlockOp[],
                                 anchors: BatchAnchors, title: string,
                                 focus: FocusTarget | null): Promise<void> {
  // A session disappears only when it has no handles and no undelivered
  // writes, so with none this tab holds nothing unresolved for the page and
  // the page as the normal read returns it is a correct tree to re-key and
  // stamp against. If that read fails the recorded batch ships as it is: the
  // recorded keys are right only while nothing shifted the page's keys since
  // recording, and an online-only session never fills the missing hashes in.
  let wireOps: BlockOp[];
  try {
    const live = await loadPage(title);
    wireOps = stampBaseTextHashes(
      live, title, resolveAnchors(live, title, batch, anchors));
  } catch (e: unknown) {
    console.warn("undo/redo could not read the page; sending unstamped", e);
    wireOps = [...batch];
  }
  sync.enqueue(wireOps, ["page", title]);
  settle(title, focus);
}

function settle(title: string, focus: FocusTarget | null): void {
  const registered = hooks.get(title);
  if (registered) {
    registered.forEach((h) => h.applyFocus(focus));
  } else {
    // No mounted outline to show the effect (a lingering session, if any,
    // already has correct data); bring the user to where it landed.
    navigator?.(pagePath(title));
  }
}
