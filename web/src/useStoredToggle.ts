// pattern: Imperative Shell
import { useCallback } from "react";
import { useStoredPref } from "./useStoredPref";

/** A stored on/off preference: `key` holds `off` or `on` as a bare string.
 * An absent or unknown string reads as `fallback`, and is then overwritten
 * with the fallback's string (useStoredPref's mount write). */
export function useStoredToggle(
  key: string,
  values: readonly [off: string, on: string],
  fallback: boolean,
): [on: boolean, toggle: () => void] {
  const [off, on] = values;
  const [value, setValue] = useStoredPref(
    key, (v): v is string => v === off || v === on, fallback ? on : off);
  const toggle = useCallback(
    () => setValue((v) => (v === on ? off : on)), [setValue, off, on]);
  return [value === on, toggle];
}
