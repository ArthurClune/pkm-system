// pattern: Imperative Shell
// Drafts an outline let go of unsaved. Each holds a ref the server refuses,
// so run() would not save it, and it could no longer stay on screen to be
// fixed: its outline unmounted, or its block left the tree or went under a
// collapsed ancestor. DroppedDraftNotice, mounted once in the app shell,
// shows each with its full text and a Copy button until dismissed, so the
// text outlives the outline that dropped it.
//
// While a dropped draft is listed, or an outline holds a pending draft with a
// refused title, a beforeunload listener asks before a reload or close loses
// it. It is attached only then: Firefox keeps a page with one out of its
// back/forward cache.
import type { CanonicalTitle } from "../api/brands";

export interface DroppedDraft {
  id: number;
  pageTitle: CanonicalTitle;
  text: string;
  /** Why it could not be saved: the refused title's notice. */
  notice: string;
}

let drafts: readonly DroppedDraft[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const refusedPending = new Set<symbol>();
let guarding = false;

const askBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };

function updateUnloadGuard(): void {
  const needed = drafts.length > 0 || refusedPending.size > 0;
  if (needed === guarding) return;
  guarding = needed;
  if (needed) window.addEventListener("beforeunload", askBeforeUnload);
  else window.removeEventListener("beforeunload", askBeforeUnload);
}

function publish(next: readonly DroppedDraft[]): void {
  drafts = next;
  updateUnloadGuard();
  listeners.forEach((l) => l());
}

/** Whether `owner` (an outline) holds a pending draft run() would refuse. */
export function setRefusedDraftPending(owner: symbol,
                                       pending: boolean): void {
  if (pending) refusedPending.add(owner);
  else refusedPending.delete(owner);
  updateUnloadGuard();
}

export function dropDraft(draft: Omit<DroppedDraft, "id">): void {
  publish([...drafts, { ...draft, id: nextId++ }]);
}

export function dismissDroppedDraft(id: number): void {
  publish(drafts.filter((d) => d.id !== id));
}

export function droppedDrafts(): readonly DroppedDraft[] {
  return drafts;
}

export function subscribeDroppedDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: dropped drafts and the unload guard are module state. */
export function resetDroppedDrafts(): void {
  refusedPending.clear();
  publish([]);
}
