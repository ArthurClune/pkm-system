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
//
// A replay that would put a block past the outline depth cap, store a
// block text past a text limit (grammar/textLimits.ts) or link a title past
// the title cap (grammar/titleLength.ts), applies and sends nothing (the
// server refuses such a batch whole, and the offline queue would discard
// it), shows the refusal's notice, and puts its entry back, so it can be
// retried once the user has made room. The entry goes back as though it had
// been refused at the keypress (restoreEntry, history.ts), so an edit
// recorded while the page was being read keeps its place. Its delivery
// resolves "failed", so a refused upload undo keeps the files. A page this
// tab cannot read is judged by the text limits and the title cap only,
// which need no tree: its depth is left to the server.
import type { Sha256Hex, CanonicalTitle } from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { BlockNode } from "../api/payloads";
import { releaseAssets } from "../sync/assetRelease";
import type { DeliveryOutcome, WriteTicket } from "../sync/opQueue";
import { pagePath } from "../paths";
import { stampBaseTextHashes } from "./baseTextHash";
import { findOpTextLimitViolation,
         textLimitNotice } from "../grammar/textLimits";
import { TITLE_LENGTH_NOTICE } from "../grammar/titleLength";
import { findOpTitleViolation } from "../replica/titles";
import { DEPTH_NOTICE, findDepthViolation } from "./depthCap";
import type { FocusTarget } from "./edits";
import { emptyHistory, recordEntry, resolveAnchors, restoreEntry, takeRedo,
         takeUndo, type BatchAnchors, type HistoryEntry,
         type HistoryState } from "./history";
import { loadOutlineBlocks } from "./loadOutlineBlocks";
import { substituteMissingDaily } from "./missingPage";
import { peekOutlineSession } from "./outlineSessions";
import { applyOps } from "./tree";

export interface HistoryDispatch {
  enqueue(ops: BlockOp[], scope?: readonly string[]): WriteTicket;
}

export interface OutlineHistoryHooks {
  /** Flush any pending debounced draft NOW (records its entry first). */
  flushPending(): void;
  /** Adopt a focus target after a history batch applied. */
  applyFocus(focus: FocusTarget | null): void;
  /** Say why a history batch for this page was refused. */
  showNotice(text: string): void;
}

let state: HistoryState = emptyHistory();
const hooks = new Map<string, Set<OutlineHistoryHooks>>();
// A refusal's notice for a page no outline showed when it was refused,
// handed to the next outline that registers for that page.
const pendingNotices = new Map<string, string>();
let navigator: ((path: string) => void) | null = null;

type PageLoader = (title: CanonicalTitle) => Promise<BlockNode[]>;
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
  title: CanonicalTitle, h: OutlineHistoryHooks,
): () => void {
  let set = hooks.get(title);
  if (!set) {
    set = new Set();
    hooks.set(title, set);
  }
  set.add(h);
  const notice = pendingNotices.get(title);
  if (notice !== undefined) {
    pendingNotices.delete(title);
    h.showNotice(notice);
  }
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

/** Release files a refused command uploaded, which no history entry owns. */
export function releaseUnusedAssets(shas: readonly Sha256Hex[]): void {
  void releaser.release(shas, []);
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
                             entry.pageTitle, entry.focusBefore, () => {
    state = restoreEntry(state, entry, "undo", next);
  });
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
                entry.focusAfter, () => {
    state = restoreEntry(state, entry, "redo", next);
  });
  return true;
}

/** Test seam: history is module state. */
export function resetHistory(): void {
  state = emptyHistory();
  loadPage = defaultPageLoader;
  releaser = defaultReleaser;
  pendingNotices.clear();
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

// The delivery of what a dispatch sent, or of nothing when it sent nothing.
type Dispatched = Pick<WriteTicket, "delivered">;

// A dispatch a reset overtook: nothing refused, sent, noticed or navigated.
const dropped = (): Dispatched =>
  ({ delivered: failed(new Error("history reset")) });

// Resolves with the dispatched write's delivery, never rejects: a dispatch
// that throws, is dropped by a reset or is refused resolves "failed".
// onRefused runs when the depth cap or a text limit refuses the batch.
function dispatch(sync: HistoryDispatch, batch: BlockOp[],
                  anchors: BatchAnchors, title: CanonicalTitle,
                  focus: FocusTarget | null,
                  onRefused: () => void): Promise<DeliveryOutcome> {
  // Dispatches apply in keypress order. With nothing queued and a session for
  // the page, apply synchronously; otherwise join the chain, so a mounted
  // page's undo never overtakes an earlier undo still waiting on a page read.
  if (queued === 0) {
    const handle = peekOutlineSession(title);
    if (handle) {
      return dispatchWithSession(sync, handle, batch, anchors, title, focus,
                                 onRefused).delivered;
    }
  }
  const mine = epoch;
  // a reset meanwhile emptied the stacks; the entry stays dropped
  const stale = () => mine !== epoch;
  queued++;
  // The step resolves once the write is enqueued, not delivered (the chain
  // must not wait on the network), so the delivery rides in a wrapper.
  const step = chain.then(async (): Promise<{
    delivered: Promise<DeliveryOutcome>;
  }> => {
    try {
      if (stale()) return dropped();
      const handle = peekOutlineSession(title);
      const write = handle
        ? dispatchWithSession(sync, handle, batch, anchors, title, focus,
                              onRefused)
        : await dispatchUnmounted(sync, batch, anchors, title, focus,
                                  onRefused, stale);
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
                             title: CanonicalTitle, focus: FocusTarget | null,
                             onRefused: () => void): Dispatched {
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
  // The write, or the notice of the refusal that stopped it.
  let outcome: WriteTicket | string;
  try {
    const live = handle.getSnapshot().blocks;
    const resolved = resolveAnchors(live, title, batch, anchors);
    const refusal = refusalNotice(live, resolved, title);
    if (refusal === null) {
      const wireOps = stampBaseTextHashes(live, title, resolved);
      const write = sync.enqueue(wireOps, ["page", title]);
      handle.applyLocal(write, wireOps);
      outcome = write;
    } else {
      outcome = refusal;
    }
  } finally {
    handle.release();
  }
  if (typeof outcome === "string") {
    return refuse(title, focus, onRefused, outcome);
  }
  settle(title, focus);
  return outcome;
}

async function dispatchUnmounted(
  sync: HistoryDispatch, batch: BlockOp[], anchors: BatchAnchors,
  title: CanonicalTitle, focus: FocusTarget | null, onRefused: () => void,
  stale: () => boolean,
): Promise<Dispatched> {
  // A session disappears only when it has no handles and no undelivered
  // writes, so with none this tab holds nothing unresolved for the page and
  // the page as the normal read returns it is a correct tree to re-key and
  // stamp against. If that read fails the recorded batch ships as it is: the
  // recorded keys are right only while nothing shifted the page's keys since
  // recording, and an online-only session never fills the missing hashes in.
  // Nor is its depth judged: the server decides. Its texts are, since that
  // needs no tree. A reset during the read drops the dispatch whole.
  let wireOps: BlockOp[];
  let refusal: string | null;
  try {
    const live = await loadPage(title);
    if (stale()) return dropped();
    const resolved = resolveAnchors(live, title, batch, anchors);
    refusal = refusalNotice(live, resolved, title);
    wireOps = stampBaseTextHashes(live, title, resolved);
  } catch (e: unknown) {
    if (stale()) return dropped();
    console.warn("undo/redo could not read the page; sending unstamped", e);
    wireOps = [...batch];
    refusal = textLimitRefusal(batch);
  }
  if (refusal !== null) return refuse(title, focus, onRefused, refusal);
  const write = sync.enqueue(wireOps, ["page", title]);
  settle(title, focus);
  return write;
}

// Why the batch must not ship, or null when it may: the depth cap first,
// judged on the tree the batch would leave (a batch that places no block,
// typing or a heading, cannot nest one deeper, and clones nothing), then the
// text limits of the texts it would store.
function refusalNotice(live: BlockNode[], ops: BlockOp[],
                       title: CanonicalTitle): string | null {
  const places = ops.some((op) => op.op === "create" || op.op === "move");
  if (places && findDepthViolation(applyOps(live, ops, title), ops) !== null) {
    return DEPTH_NOTICE;
  }
  return textLimitRefusal(ops);
}

// The refusals that need no tree: the text limits, then a title past the
// title cap (an undo can restore a link a block held before the cap).
function textLimitRefusal(ops: BlockOp[]): string | null {
  const overLimit = findOpTextLimitViolation(ops);
  if (overLimit !== null) return textLimitNotice(overLimit.violation);
  return findOpTitleViolation(ops)?.reason === "too_long"
    ? TITLE_LENGTH_NOTICE : null;
}

// Nothing applied or sent; the notice goes to the page's outlines, or waits
// for the next one when none is mounted, and settle brings the user there.
function refuse(title: CanonicalTitle, focus: FocusTarget | null,
                onRefused: () => void, notice: string): Dispatched {
  onRefused();
  const registered = hooks.get(title);
  if (registered) {
    registered.forEach((h) => h.showNotice(notice));
  } else {
    pendingNotices.set(title, notice);
  }
  settle(title, focus);
  return { delivered: failed(new Error(notice)) };
}

function settle(title: CanonicalTitle, focus: FocusTarget | null): void {
  const registered = hooks.get(title);
  if (registered) {
    registered.forEach((h) => h.applyFocus(focus));
  } else {
    // No mounted outline to show the effect (a lingering session, if any,
    // already has correct data); bring the user to where it landed.
    navigator?.(pagePath(title));
  }
}
