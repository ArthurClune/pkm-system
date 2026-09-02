// pattern: Functional Core
// The resolved-((uid))-text store behind BlockRefProvider: a uid-keyed Map
// plus per-uid listener sets, shaped for useSyncExternalStore. No I/O -- the
// provider owns the fetch and hands batches to `resolve`. Same "mutable
// container behind a factory" shape as renderCache.ts.
//
// Per-uid subscription is the point. Holding the resolved texts in React
// state meant every arriving batch produced a new context value, so one
// pasted ref resolving re-rendered every ((uid)) on the page (and, on the
// Journal, every loaded day). Here a batch wakes only the consumers of the
// uids it actually resolved.
import type { BlockRefText } from "../api/payloads";

export interface BlockRefStore {
  /** The resolved entry, or undefined. Stable identity while unchanged, as
   * useSyncExternalStore's getSnapshot requires. */
  get(uid: string): BlockRefText | undefined;
  /** Listen for changes to ONE uid. Returns the unsubscribe function. */
  subscribe(uid: string, onChange: () => void): () => void;
  /** Merge a fetched batch, waking only the uids it changed. */
  resolve(entries: Record<string, BlockRefText>): void;
  /** Drop an entry and wake its consumers, so the next reader re-requests
   * it. This is the whole shape an invalidation needs (pkm-1w6u): resolved
   * texts currently never expire, and the fix is a `forget` per edited uid
   * rather than any change to how consumers read. */
  forget(uid: string): void;
  /** Claim a uid for fetching. True the first time, false afterwards, so a
   * uid the server doesn't know is asked for once and never in a loop. */
  claimRequest(uid: string): boolean;
  /** Live claims — for the test that pins the bound below. */
  claimCount(): number;
}

export function createBlockRefStore(): BlockRefStore {
  const texts = new Map<string, BlockRefText>();
  const listeners = new Map<string, Set<() => void>>();
  // Bounded by the number of uids seen that the server could NOT resolve:
  // `resolve` drops the claim for every uid it fills, because a consumer
  // holding a resolved text stops asking, so that claim can never be the
  // thing preventing a refetch loop. Only unknown uids need the guard, and
  // only they are retained.
  const claimed = new Set<string>();

  const notify = (uid: string): void => {
    const set = listeners.get(uid);
    if (!set) return;
    for (const onChange of set) onChange();
  };

  return {
    get(uid) {
      return texts.get(uid);
    },
    subscribe(uid, onChange) {
      let set = listeners.get(uid);
      if (!set) {
        set = new Set();
        listeners.set(uid, set);
      }
      set.add(onChange);
      return () => {
        set.delete(onChange);
        if (set.size === 0) listeners.delete(uid);
      };
    },
    resolve(entries) {
      for (const [uid, entry] of Object.entries(entries)) {
        texts.set(uid, entry);
        claimed.delete(uid);
        notify(uid);
      }
    },
    forget(uid) {
      if (!texts.delete(uid)) return;
      claimed.delete(uid);
      notify(uid);
    },
    claimRequest(uid) {
      if (claimed.has(uid) || texts.has(uid)) return false;
      claimed.add(uid);
      return true;
    },
    claimCount() {
      return claimed.size;
    },
  };
}
