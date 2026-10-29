// pattern: Imperative Shell
// Drafts an outline let go of unsaved. Each holds a ref the server refuses,
// so run() would not save it, and it could no longer stay on screen to be
// fixed: its outline unmounted, or its block left the tree or went under a
// collapsed ancestor. DroppedDraftNotice, mounted once in the app shell,
// shows each with its full text and a Copy button until dismissed, so the
// text outlives the outline that dropped it.
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

function publish(next: readonly DroppedDraft[]): void {
  drafts = next;
  listeners.forEach((l) => l());
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

/** Test seam: dropped drafts are module state. */
export function resetDroppedDrafts(): void {
  publish([]);
}
