// pattern: Imperative Shell
import { useCallback, useEffect, useState } from "react";
import {
  isThemePreference,
  nextThemePreference,
  resolveEffectiveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";
import { useStoredPref } from "./useStoredPref";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** Stamps data-theme so CSS can force a palette regardless of the OS
 * setting. "system" also gets the attribute (rather than none) so callers
 * can always read the current preference straight off the DOM; styles.css
 * only special-cases the "light" value (to suppress the dark media query). */
function applyToDocument(preference: ThemePreference) {
  document.documentElement.setAttribute("data-theme", preference);
}

export function useTheme() {
  const [preference, setPreference] =
    useStoredPref(THEME_STORAGE_KEY, isThemePreference, "system");
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia(DARK_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => { applyToDocument(preference); }, [preference]);

  const cycle = useCallback(() => setPreference(nextThemePreference),
    [setPreference]);

  return {
    preference,
    effective: resolveEffectiveTheme(preference, systemPrefersDark),
    cycle,
  };
}
