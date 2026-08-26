// pattern: Imperative Shell
// The effective (resolved) theme, observed from the DOM rather than owned
// state: useTheme()'s preference lives in per-component useStoredPref state,
// so a second useTheme() call would never see ThemeToggle's cycle. The
// data-theme attribute useTheme stamps on <html> (plus the OS media query
// for "system") is the one cross-component signal, so consumers that must
// react to theme flips (e.g. re-rendering a mermaid diagram) watch that.
import { useEffect, useState } from "react";
import { isThemePreference, resolveEffectiveTheme, type EffectiveTheme } from "./theme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readEffectiveTheme(): EffectiveTheme {
  const attr = document.documentElement.getAttribute("data-theme");
  const preference = isThemePreference(attr) ? attr : "system";
  const prefersDark = window.matchMedia?.(DARK_MEDIA_QUERY).matches ?? false;
  return resolveEffectiveTheme(preference, prefersDark);
}

export function useEffectiveTheme(): EffectiveTheme {
  const [effective, setEffective] = useState<EffectiveTheme>(readEffectiveTheme);

  useEffect(() => {
    const update = () => setEffective(readEffectiveTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mql = window.matchMedia?.(DARK_MEDIA_QUERY);
    mql?.addEventListener("change", update);
    return () => {
      observer.disconnect();
      mql?.removeEventListener("change", update);
    };
  }, []);

  return effective;
}
