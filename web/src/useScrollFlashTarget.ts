// pattern: Imperative Shell
// Scroll a just-rendered block into view and flash it (pkm-kk0t), shared by
// the main pane (target from the URL hash, pkm-pzdu) and a sidebar panel
// (target from the opening shift-click, pkm-gdi5).
//
// `ready` is the caller's render gate -- the page payload itself, not a
// boolean derived from it. Its identity is in the dependency array, so a
// resync that replaces the payload re-runs the scroll for the same target,
// which is what the main pane has always done.
//
// `root`, when given, scopes the lookup to that subtree and NEVER falls back
// to the document: the same page can be open in the main pane and a sidebar
// panel at once, both rendering an element with this data-uid, and a panel
// must not scroll the other one. A root that has not mounted yet (current
// null) is therefore a no-op, not a document-wide search.
import { useEffect, type RefObject } from "react";

/** Matches the .flash-target animation in styles.css; the class has to
 * outlive the animation or it stops part-way through. */
export const FLASH_MS = 1600;

export function useScrollFlashTarget(
  uid: string | null | undefined,
  ready: unknown,
  root?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!ready || !uid) return;
    const scope = root ? root.current : document;
    if (!scope) return;
    const el = scope.querySelector(`[data-uid="${CSS.escape(uid)}"]`);
    if (!el) return; // deleted, or inside a collapsed subtree
    el.scrollIntoView({ block: "center" });
    el.classList.add("flash-target");
    const timer = setTimeout(() => el.classList.remove("flash-target"), FLASH_MS);
    return () => clearTimeout(timer);
  }, [uid, ready, root]);
}
