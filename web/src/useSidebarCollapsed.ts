// pattern: Imperative Shell
import { useCallback, useEffect, useState } from "react";
import {
  isSidebarState,
  SIDEBAR_STORAGE_KEY,
  toggleSidebarState,
  type SidebarState,
} from "./sidebar";

function readStoredState(): SidebarState {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return isSidebarState(stored) ? stored : "open";
  } catch {
    return "open"; // localStorage unavailable (private mode / disabled)
  }
}

function persistState(state: SidebarState) {
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, state);
  } catch {
    // Not persisted this session; the in-memory state still works.
  }
}

/** Desktop left-nav collapse state, persisted across reloads (see
 * SIDEBAR_STORAGE_KEY). This is unrelated to the mobile overlay's own
 * open/closed state -- styles.css makes the phone-breakpoint hamburger win
 * regardless of what this hook reports. */
export function useSidebarCollapsed() {
  const [state, setState] = useState<SidebarState>(readStoredState);

  useEffect(() => {
    persistState(state);
  }, [state]);

  const toggle = useCallback(() => setState(toggleSidebarState), []);

  return { collapsed: state === "collapsed", toggle };
}
