// pattern: Imperative Shell
import { useCallback } from "react";
import { isSidebarState, SIDEBAR_STORAGE_KEY, toggleSidebarState } from "./sidebar";
import { useStoredPref } from "./useStoredPref";

/** Desktop left-nav collapse state, persisted across reloads (see
 * SIDEBAR_STORAGE_KEY). This is unrelated to the mobile overlay's own
 * open/closed state -- styles.css makes the phone-breakpoint hamburger win
 * regardless of what this hook reports. */
export function useSidebarCollapsed() {
  const [state, setState] =
    useStoredPref(SIDEBAR_STORAGE_KEY, isSidebarState, "open");
  const toggle = useCallback(() => setState(toggleSidebarState), [setState]);
  return { collapsed: state === "collapsed", toggle };
}
