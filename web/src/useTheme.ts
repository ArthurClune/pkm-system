// pattern: Imperative Shell
import { useCallback, useEffect, useState } from "react";
import {
  isThemePreference,
  nextThemePreference,
  resolveEffectiveTheme,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "./theme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readStoredPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system"; // localStorage unavailable (private mode / disabled)
  }
}

function persistPreference(preference: ThemePreference) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not persisted this session; the in-memory state still works.
  }
}

/** Stamps data-theme so CSS can force a palette regardless of the OS
 * setting. "system" also gets the attribute (rather than none) so callers
 * can always read the current preference straight off the DOM; styles.css
 * only special-cases the "light" value (to suppress the dark media query). */
function applyToDocument(preference: ThemePreference) {
  document.documentElement.setAttribute("data-theme", preference);
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readStoredPreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => window.matchMedia(DARK_MEDIA_QUERY).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(DARK_MEDIA_QUERY);
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    applyToDocument(preference);
    persistPreference(preference);
  }, [preference]);

  const cycle = useCallback(() => setPreference(nextThemePreference), []);

  return {
    preference,
    effective: resolveEffectiveTheme(preference, systemPrefersDark),
    cycle,
  };
}
