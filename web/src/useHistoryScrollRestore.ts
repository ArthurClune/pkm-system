// pattern: Imperative Shell
// Back and forward put the window where that history entry left it.
//
// The browser's own restoration cannot: it scrolls at popstate, before React
// renders the entry, and a view that shows "Loading…" first (PageView) shrinks
// the document to one viewport, which clamps the offset to 0. So restoration
// is manual. Every scroll records the offset under the current entry's key,
// and after a POP the recorded offset is re-applied whenever the main pane
// changes size, until it has held for PIN_QUIET_MS or the reader takes over.
// Scrolls are not recorded while the offset is being re-applied: the clamp
// to 0 would otherwise overwrite the very offset being restored.
//
// A scroll event is dispatched on the next frame, so the last scroll before
// a back or forward in the same frame would arrive after the key has moved
// and be dropped. The outgoing offset is therefore also recorded at
// popstate, by a listener that must run before react-router's: BrowserRouter
// updates the location in a transition, which React 19 commits during a
// popstate as soon as that listener returns, so a later listener sees the
// incoming entry's key and an offset already clamped by "Loading…". (A test's
// dispatchEvent runs every listener before that commit; only a browser shows
// the order, in e2e/history-scroll.spec.ts.) Chromium runs window's
// popstate listeners in the order they were added, whatever their capture
// flag, so ours is added in a layout effect: this hook sits under the
// router, and a child's layout effects run before the parent's, where
// BrowserRouter subscribes. That holds only while the hook mounts in the
// router's first commit and its effect never re-runs (a Fast Refresh of App
// re-runs it, so back/forward misbehaves until a reload). In WebKit, which
// runs capture listeners first, the capture flag also keeps ours first if
// the hook ever mounts after the router; Chromium ignores it for ordering.
//
// The key lives in history.state. react-router keys every entry it pushes,
// but gives the tab's first entry the location key "default" without
// writing it there, so every fresh load would share one key; that entry is
// given a key of its own. A reload keeps history.state, and the offsets are
// saved to sessionStorage on pagehide, so a reload restores too.
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLocation, useNavigationType, type NavigationType } from "react-router";
import { parseScrollOffsets, serializeScrollOffsets } from "./historyScroll";
import { PIN_QUIET_MS, READER_INPUT } from "./useScrollFlashTarget";

const STORAGE_KEY = "pkm.history-scroll";

/** Lets go of an offset the page never grows tall enough to reach. */
export const RESTORE_GIVE_UP_MS = 10_000;

let offsets: Map<string, number> | null = null;

function store(): Map<string, number> {
  if (!offsets) {
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch {
      // storage blocked: offsets last for this document only
    }
    offsets = parseScrollOffsets(raw);
  }
  return offsets;
}

function persist(): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, serializeScrollOffsets(store()));
  } catch {
    // storage blocked or full: a reload starts at the top
  }
}

function entryKey(): string | null {
  const state: unknown = window.history.state;
  if (typeof state !== "object" || state === null || !("key" in state)) return null;
  const { key } = state;
  return typeof key === "string" && key !== "default" ? key : null;
}

function ensureEntryKey(): string {
  const existing = entryKey();
  if (existing) return existing;
  const key = Math.random().toString(36).slice(2, 10);
  const state: unknown = window.history.state;
  window.history.replaceState(
    { ...(typeof state === "object" && state !== null ? state : {}), key }, "");
  return key;
}

function record(key: string, y: number): void {
  const map = store();
  map.delete(key); // re-inserted last, so serialize keeps the newest
  map.set(key, y);
}

/** Only for tests: forget every recorded offset. */
export function resetHistoryScroll(): void {
  offsets = null;
}

/**
 * Whether this navigation restores a recorded offset, so a view that would
 * otherwise scroll to a target of its own (PageView's #uid) leaves it alone.
 * Decided once per navigation: the first scroll after it records an offset.
 */
export function useRestoresHistoryScroll(): boolean {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [decision, setDecision] =
    useState(() => ({ location, restores: restores(navigationType) }));
  if (decision.location === location) return decision.restores;
  const next = { location, restores: restores(navigationType) };
  setDecision(next);
  return next.restores;
}

function restores(navigationType: NavigationType): boolean {
  const key = entryKey();
  return navigationType === "POP" && key !== null && store().has(key);
}

export function useHistoryScrollRestore(content: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const navigationType = useNavigationType();
  const current = useRef<string | null>(null);
  const pinning = useRef(false);

  useLayoutEffect(() => {
    const previous = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    const onScroll = () => {
      if (!pinning.current && current.current) record(current.current, window.scrollY);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", onScroll, true);
    window.addEventListener("pagehide", persist);
    return () => {
      window.history.scrollRestoration = previous;
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onScroll, true);
      window.removeEventListener("pagehide", persist);
    };
  }, []);

  // A layout effect, so the key moves to the new entry in the commit that
  // renders it, before any scroll that commit causes is dispatched.
  useLayoutEffect(() => {
    const key = ensureEntryKey();
    current.current = key;
    const target = navigationType === "POP" ? store().get(key) : undefined;
    const pane = content.current;
    if (target === undefined || !pane) return;

    pinning.current = true;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => apply());
    const release = () => {
      clearTimeout(quietTimer);
      clearTimeout(giveUpTimer);
      observer?.disconnect();
      for (const type of READER_INPUT) window.removeEventListener(type, release, true);
      pinning.current = false;
    };
    const apply = () => {
      window.scrollTo(0, target);
      clearTimeout(quietTimer);
      // Not there yet (the entry is still loading): wait for the next resize.
      if (Math.abs(window.scrollY - target) < 1) quietTimer = setTimeout(release, PIN_QUIET_MS);
    };
    const giveUpTimer = setTimeout(release, RESTORE_GIVE_UP_MS);
    observer?.observe(pane);
    for (const type of READER_INPUT) window.addEventListener(type, release, true);
    apply();
    return release;
  }, [location, navigationType, content]);
}
