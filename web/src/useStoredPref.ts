// pattern: Imperative Shell
// One localStorage-backed user preference (pkm-kk0t): a bare string
// validated by a type guard, read once on mount and written back on every
// change. Storage is best-effort at both ends -- a read that throws
// (private mode, storage disabled) yields the fallback, and a write that
// throws is dropped, leaving the in-memory value working for the rest of
// the session. The mount write is deliberate: it materialises the default
// so a later reader sees an explicit value rather than an absent key.
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** Narrows a raw localStorage read (which may be null) to the stored type. */
export type StoredPrefGuard<T extends string> =
  (value: string | null | undefined) => value is T;

export function useStoredPref<T extends string>(
  key: string,
  isValid: StoredPrefGuard<T>,
  fallback: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return isValid(stored) ? stored : fallback;
    } catch {
      return fallback; // localStorage unavailable (private mode / disabled)
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not persisted this session; the in-memory value still works.
    }
  }, [key, value]);

  return [value, setValue];
}
