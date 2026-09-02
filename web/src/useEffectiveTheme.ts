// pattern: Imperative Shell
// The effective (resolved) theme, observed from the DOM rather than owned
// state: useTheme()'s preference lives in per-component useStoredPref state,
// so a second useTheme() call would never see ThemeToggle's cycle. The
// data-theme attribute useTheme stamps on <html> (plus the OS media query
// for "system") is the one cross-component signal, so consumers that must
// react to theme flips (e.g. re-rendering a mermaid diagram) watch that.
//
// A single module-level store backs every useEffectiveTheme() call, with
// exactly one MutationObserver and one matchMedia listener shared by all
// subscribers -- installed lazily on the first subscribe() and torn down
// once the last unsubscribes. Before this, each call installed its own pair
// (a page with 20 mermaid diagrams meant 20 redundant observers reacting to
// the same single data-theme flip). useSyncExternalStore is the right
// primitive for this: subscribe/getSnapshot is exactly "one shared
// listener set, read a live value", with none of a Context's provider
// plumbing -- every existing call site's `useEffectiveTheme(): EffectiveTheme`
// signature is unchanged.
import { useSyncExternalStore } from "react";
import { isThemePreference, resolveEffectiveTheme, type EffectiveTheme } from "./theme";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

function readEffectiveTheme(): EffectiveTheme {
  const attr = document.documentElement.getAttribute("data-theme");
  const preference = isThemePreference(attr) ? attr : "system";
  const prefersDark = window.matchMedia?.(DARK_MEDIA_QUERY).matches ?? false;
  return resolveEffectiveTheme(preference, prefersDark);
}

let observer: MutationObserver | null = null;
let mql: MediaQueryList | null = null;
const listeners = new Set<() => void>();

function notifyAll() {
  listeners.forEach((listener) => listener());
}

function subscribe(onStoreChange: () => void): () => void {
  if (listeners.size === 0) {
    observer = new MutationObserver(notifyAll);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    mql = window.matchMedia?.(DARK_MEDIA_QUERY) ?? null;
    mql?.addEventListener("change", notifyAll);
  }
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      mql?.removeEventListener("change", notifyAll);
      mql = null;
    }
  };
}

export function useEffectiveTheme(): EffectiveTheme {
  return useSyncExternalStore(subscribe, readEffectiveTheme);
}
