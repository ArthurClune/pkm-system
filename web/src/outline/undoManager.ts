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
//
// Undoing an upload is final: takeUndo clears the redo stack, and once the
// undo's write has reached the server its fresh uploads are released (a
// conditional server delete, refused while any block still references the
// file). An undo whose delivery fails leaves the files.
import type { Sha256Hex } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { releaseAssets } from "../sync/assetRelease";
import type { DeliveryOutcome, WriteTicket } from "../sync/opQueue";
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

export interface AssetReleaser {
  release(shas: readonly Sha256Hex[],
          waitFor: readonly Promise<DeliveryOutcome>[]): Promise<void>;
}
const defaultReleaser: AssetReleaser = {
  release: (shas, waitFor) => releaseAssets(shas, waitFor),
};
let releaser: AssetReleaser = defaultReleaser;

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

/** Test seam: how fresh assets are released. */
export function setAssetReleaser(r: AssetReleaser): () => void {
  releaser = r;
  return () => {
    if (releaser === r) releaser = defaultReleaser;
  };
}

/** Test seam: resolves when no queued dispatch remains. */
export async function historyIdle(): Promise<void> {
  while (queued > 0) await chain;
}

export function recordHistory(entry: HistoryEntry): void {
  state = recordEntry(state, entry);
}

export function performUndo(sync: HistoryDispatch): boolean {
  flushAll(); // a pending draft becomes the newest entry, then gets undone
  const { state: next, entry } = takeUndo(state);
  state = next;
  if (!entry) return false;
  const delivered = dispatch(sync, entry.inverse, entry.anchors.inverse,
                             entry.pageTitle, entry.focusBefore);
  if (entry.freshAssets.length > 0) {
    void releaser.release(entry.freshAssets, [delivered]);
  }
  return true;
}

export function performRedo(sync: HistoryDispatch): boolean {
  flushAll(); // a pending draft is a NEW op: recording it clears redo (AC)
  const { state: next, entry } = takeRedo(state);
  state = next;
  if (!entry) return false;
  void dispatch(sync, entry.ops, entry.anchors.ops, entry.pageTitle,
                entry.focusAfter);
  return true;
}

/** Test seam: history is module state. */
export function resetHistory(): void {
  state = emptyHistory();
  loadPage = defaultPageLoader;
  releaser = defaultReleaser;
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

const failed = (error: unknown): Promise<DeliveryOutcome> =>
  Promise.resolve({ status: "failed", error });

// Resolves with the dispatched write's delivery, never rejects: a dispatch
// that throws or is dropped by a reset resolves "failed".
function dispatch(sync: HistoryDispatch, batch: BlockOp[],
                  anchors: BatchAnchors, title: string,
                  focus: FocusTarget | null): Promise<DeliveryOutcome> {
  // Dispatches apply in keypress order. With nothing queued and a session for
  // the page, apply synchronously; otherwise join the chain, so a mounted
  // page's undo never overtakes an earlier undo still waiting on a page read.
  if (queued === 0) {
    const handle = peekOutlineSession(title);
    if (handle) {
      return dispatchWithSession(sync, handle, batch, anchors, title, focus)
        .delivered;
    }
  }
  const mine = epoch;
  queued++;
  // The step resolves once the write is enqueued, not delivered (the chain
  // must not wait on the network), so the delivery rides in a wrapper.
  const step = chain.then(async (): Promise<{
    delivered: Promise<DeliveryOutcome>;
  }> => {
    try {
      if (mine !== epoch) {
        return { delivered: failed(new Error("history reset")) };
      }
      const handle = peekOutlineSession(title);
      const write = handle
        ? dispatchWithSession(sync, handle, batch, anchors, title, focus)
        : await dispatchUnmounted(sync, batch, anchors, title, focus);
      return { delivered: write.delivered };
    } catch (e: unknown) {
      console.error("undo/redo dispatch failed", e);
      return { delivered: failed(e) };
    } finally {
      if (mine === epoch) queued--;
    }
  });
  chain = step.then(() => undefined);
  return step.then((s) => s.delivered);
}

type SessionHandle = NonNullable<ReturnType<typeof peekOutlineSession>>;

function dispatchWithSession(sync: HistoryDispatch, handle: SessionHandle,
                             batch: BlockOp[], anchors: BatchAnchors,
                             title: string,
                             focus: FocusTarget | null): WriteTicket {
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
  let write: WriteTicket;
  try {
    const live = handle.getSnapshot().blocks;
    const wireOps = stampBaseTextHashes(
      live, title, resolveAnchors(live, title, batch, anchors));
    write = sync.enqueue(wireOps, ["page", title]);
    handle.applyLocal(write, wireOps);
  } finally {
    handle.release();
  }
  settle(title, focus);
  return write;
}

async function dispatchUnmounted(
  sync: HistoryDispatch, batch: BlockOp[], anchors: BatchAnchors,
  title: string, focus: FocusTarget | null,
): Promise<WriteTicket> {
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
  const write = sync.enqueue(wireOps, ["page", title]);
  settle(title, focus);
  return write;
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
