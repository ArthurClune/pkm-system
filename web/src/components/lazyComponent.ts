// pattern: Imperative Shell
// A component whose chunk loads on first use, so a page without one never
// pays for it in the entry chunk.
import { useEffect, useState } from "react";

/** One load shared by every caller; a failed one is forgotten, so the next
 * mount retries instead of replaying the rejection. */
export function lazyLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    if (!promise) {
      promise = load();
      promise.catch(() => { promise = null; });
    }
    return promise;
  };
}

export type Lazy<T> =
  | { status: "loading" }
  | { status: "ok"; value: T }
  | { status: "error"; message: string };

/** What `load` gave; nothing loads while `skip`. */
export function useLazy<T>(load: () => Promise<T>, skip = false): Lazy<T> {
  const [state, setState] = useState<Lazy<T>>({ status: "loading" });
  useEffect(() => {
    if (skip) return;
    let live = true;
    load().then(
      (value) => { if (live) setState({ status: "ok", value }); },
      (e: unknown) => { if (live) setState({ status: "error", message: String(e) }); });
    return () => { live = false; };
  }, [load, skip]);
  return state;
}
