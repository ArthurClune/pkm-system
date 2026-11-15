// pattern: Imperative Shell
// A component whose chunk loads on first use, so a page without one never
// pays for it in the entry chunk.
import { useEffect, useState } from "react";

export interface Loader<T> {
  (): Promise<T>;
  /** The loaded value once the load has resolved. */
  peek(): T | undefined;
}

/** One load shared by every caller; a failed one is forgotten, so the next
 * mount retries instead of replaying the rejection. */
export function lazyLoader<T>(load: () => Promise<T>): Loader<T> {
  let promise: Promise<T> | null = null;
  let loaded: T | undefined;
  const get = () => promise ??= load().then(
    (value) => (loaded = value),
    (e: unknown) => { promise = null; throw e; });
  return Object.assign(get, { peek: () => loaded });
}

export type Lazy<T> =
  | { status: "loading" }
  | { status: "ok"; value: T }
  | { status: "error"; message: string };

/** What `load` gave; nothing loads while `skip`. A mount after the load
 * has resolved starts with the value, so it renders the loaded component on
 * its first render instead of a placeholder for a frame. */
export function useLazy<T>(load: Loader<T>, skip = false): Lazy<T> {
  const [state, setState] = useState<Lazy<T>>(() => {
    const value = load.peek();
    return value === undefined ? { status: "loading" } : { status: "ok", value };
  });
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
