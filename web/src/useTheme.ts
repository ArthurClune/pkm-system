// pattern: Imperative Shell
import { useCallback, useEffect } from "react";
import {
  isThemePreference,
  nextThemePreference,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";
import { useStoredPref } from "./useStoredPref";

/** Stamps data-theme so CSS can force a palette regardless of the OS
 * setting. "system" also gets the attribute (rather than none) so callers
 * can always read the current preference straight off the DOM; styles.css
 * only special-cases the "light" value (to suppress the dark media query). */
function applyToDocument(preference: ThemePreference) {
  document.documentElement.setAttribute("data-theme", preference);
}

/** The stored theme preference and its cycle. What renders is read from the
 * DOM by useEffectiveTheme. */
export function useTheme() {
  const [preference, setPreference] =
    useStoredPref(THEME_STORAGE_KEY, isThemePreference, "system");

  useEffect(() => { applyToDocument(preference); }, [preference]);

  const cycle = useCallback(() => setPreference(nextThemePreference),
    [setPreference]);

  return { preference, cycle };
}
