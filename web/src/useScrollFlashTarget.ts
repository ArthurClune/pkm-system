// pattern: Imperative Shell
// Scroll a just-rendered block into view and flash it, shared by
// the main pane (target from the URL hash) and a sidebar panel
// (target from the opening shift-click).
//
// `ready` is the caller's render gate -- the page payload itself, not a
// boolean derived from it. Its identity is in the dependency array, so a
// resync that replaces the payload re-runs the scroll for the same target,
// which is what the main pane has always done.
//
// `navigation` is whatever identifies one navigation (the router's
// location key). A second click on the same toc entry or block ref leaves
// the uid unchanged, so without it the jump would happen only once.
//
// `root`, when given, scopes the lookup to that subtree and NEVER falls back
// to the document: the same page can be open in the main pane and a sidebar
// panel at once, both rendering an element with this data-uid, and a panel
// must not scroll the other one. A root that has not mounted yet (current
// null) is therefore a no-op, not a document-wide search.
//
// The jump is not finished when scrollIntoView returns. Content above the
// target keeps changing height after first paint -- PDF pages replace their
// estimated slots as they render, embeds resize their iframes -- and
// browser scroll anchoring does not hold a target that sits below the
// viewport's first visible element. So the target is re-centred whenever
// one of its ancestors changes size, until the reader takes over (any wheel,
// touch, key or pointer input) or the layout has been quiet for PIN_QUIET_MS.
import { useEffect, type RefObject } from "react";
import type { BlockUid } from "./api/brands";

/** Matches the .flash-target animation in styles.css; the class has to
 * outlive the animation or it stops part-way through. */
export const FLASH_MS = 1600;

/** How long the layout must stay still before the target is let go. */
export const PIN_QUIET_MS = 2000;

const READER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

export function useScrollFlashTarget(
  uid: BlockUid | null | undefined,
  ready: unknown,
  { root, navigation }: {
    root?: RefObject<HTMLElement | null>;
    navigation?: unknown;
  } = {},
): void {
  useEffect(() => {
    if (!ready || !uid) return;
    const scope = root ? root.current : document;
    if (!scope) return;
    const el = scope.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
    if (!el) return; // deleted, or inside a collapsed subtree
    const centre = () => el.scrollIntoView({ block: "center" });
    centre();
    el.classList.add("flash-target");
    const flashTimer = setTimeout(() => el.classList.remove("flash-target"), FLASH_MS);
    if (typeof ResizeObserver === "undefined") return () => clearTimeout(flashTimer);

    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      centre();
      settle();
    });
    const release = () => {
      clearTimeout(quietTimer);
      observer.disconnect();
      for (const type of READER_INPUT) window.removeEventListener(type, release, true);
    };
    const settle = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(release, PIN_QUIET_MS);
    };
    // Not the scope alone: body is pinned at 100% height, so its box never
    // changes. Whatever grows above the target grows the ancestor the two
    // share, and every ancestor between it and the target's scope.
    const top = scope instanceof Document ? scope.documentElement : scope;
    for (let a = el.parentElement; a; a = a === top ? null : a.parentElement) {
      observer.observe(a);
    }
    for (const type of READER_INPUT) window.addEventListener(type, release, true);
    settle();

    return () => {
      clearTimeout(flashTimer);
      release();
    };
  }, [uid, ready, root, navigation]);
}
