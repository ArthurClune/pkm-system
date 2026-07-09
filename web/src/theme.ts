// pattern: Functional Core
// Three-way theme preference: "system" follows the OS via a CSS media query
// (and needs no JS to render correctly, even before hydration); "light" and
// "dark" are explicit overrides stamped onto <html data-theme> by the shell.

export type ThemePreference = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "pkm:theme";

const PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

export function isThemePreference(value: string | null | undefined): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

/** Cycles system -> light -> dark -> system, for a single toggle control. */
export function nextThemePreference(current: ThemePreference): ThemePreference {
  const idx = PREFERENCES.indexOf(current);
  return PREFERENCES[(idx + 1) % PREFERENCES.length];
}

/** Resolves what should actually render, given the stored preference and
 * whether the OS is currently in dark mode. */
export function resolveEffectiveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): EffectiveTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}
