// pattern: Imperative Shell
// The one dismissal contract every transient surface in the app shares
// (pkm-2i6a): a mousedown that lands outside the surface, or Escape pressed
// anywhere, closes it. Both listeners sit on `document`, deliberately:
// - mousedown, not click, so the surface goes away on press rather than
//   waiting for a release that may never come over it;
// - document, not the element, so Escape still works once focus has wandered
//   off the surface, and so a portalled child counts as inside via
//   `contains` (React portals bubble their events, but the DOM containment
//   check is what decides here — pass a ref to an element that actually
//   contains the portalled node, or keep the portal's own handler).
import { useEffect } from "react";

export function useDismiss(
  /** The surface. Anything outside it is outside; a null ref is all-outside. */
  ref: React.RefObject<HTMLElement | null>,
  onDismiss: () => void,
  { enabled = true, preventDefaultOnEscape = false }: {
    /** False for a surface whose component stays mounted while closed. */
    enabled?: boolean;
    /** True where the surface claims the keystroke outright (the popovers
     * and BlockMenu do); false where Escape is also meaningful to whatever
     * has focus, e.g. an input's own handler. */
    preventDefaultOnEscape?: boolean;
  } = {},
): void {
  useEffect(() => {
    if (!enabled) return;
    const onMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (preventDefaultOnEscape) e.preventDefault();
      onDismiss();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, onDismiss, enabled, preventDefaultOnEscape]);
}
