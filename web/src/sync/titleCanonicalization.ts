// pattern: Imperative Shell
// The main thread's copy of the plain-space title flag. The flag lives in
// the replica worker's sync_client_meta; the SPA needs it to canonicalize a
// title read from block text (a backlink chip) the way the server and the
// replica do. The copy starts false, until a source has reported, and is fed
// by replicaSync from the replica's init and from every snapshot and changes
// payload. An online-only session (replica unusable) never fetches either, so
// the copy stays false there: padded titles read as distinct pages.

import { useSyncExternalStore } from "react";
import { type TitleReader, titleReaderFor as mintTitleReader } from "../replica/titles";

let plainSpaceActive = false;
const listeners = new Set<() => void>();

export function setPlainSpaceTitleCanonicalization(active: boolean): void {
  if (active === plainSpaceActive) return;
  plainSpaceActive = active;
  for (const notify of [...listeners]) notify();
}

export function plainSpaceTitleCanonicalizationNow(): boolean {
  return plainSpaceActive;
}

/** Test only: back to the default before any source reported. */
export function resetPlainSpaceTitleCanonicalization(): void {
  setPlainSpaceTitleCanonicalization(false);
}

const subscribe = (notify: () => void): (() => void) => {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
};

const readers = new Map<boolean, TitleReader>();

/** One reader per flag value, so its identity is a stable memo key. */
export function titleReaderFor(active: boolean): TitleReader {
  let reader = readers.get(active);
  if (!reader) {
    reader = mintTitleReader(active);
    readers.set(active, reader);
  }
  return reader;
}

/** A reader for the current flag; the component re-renders when it flips.
 * The reader's identity is stable per flag value, so it is a safe memo key. */
export function useTitleReader(): TitleReader {
  const active = useSyncExternalStore(
    subscribe, plainSpaceTitleCanonicalizationNow, () => false);
  return titleReaderFor(active);
}
