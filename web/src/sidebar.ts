// pattern: Functional Core
// Left sidebar collapse preference, persisted across reloads. Mirrors the
// theme preference pattern in theme.ts: a bare string in localStorage,
// validated with a type guard. This is a desktop-only concept -- the mobile
// overlay (hamburger + .left-nav.open) is unrelated state; see styles.css
// for how the phone breakpoint makes the hamburger win regardless of this.

export type SidebarState = "open" | "collapsed";

export const SIDEBAR_STORAGE_KEY = "pkm:sidebar";

export function isSidebarState(value: string | null | undefined): value is SidebarState {
  return value === "open" || value === "collapsed";
}

/** Flips the current state for a single toggle control. */
export function toggleSidebarState(current: SidebarState): SidebarState {
  return current === "open" ? "collapsed" : "open";
}
