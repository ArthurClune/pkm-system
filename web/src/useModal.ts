// pattern: Imperative Shell
// Modal behaviour for every dialog surface: Escape closes, Tab stays inside,
// the page behind does not scroll, and focus goes back where it came from.
//
// Each open modal listens on window in the capture phase, and only the one on
// top of the module's stack acts: every capture listener on window runs
// whatever stopPropagation says, outer modal first, so without the stack one
// Escape would close both. Escape is stopped in the capture phase because
// hosts (the assistant panel's onKeyDown) also close on Escape, and a portal's
// events bubble through the React tree to them.
import { useEffect, useRef, type RefObject } from "react";
import { FOCUSABLE_SELECTOR, focusWrapTarget } from "./focusWrap";

export interface ModalOptions {
  surfaceRef: RefObject<HTMLElement | null>;
  initialFocusRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Focus returns here on unmount; without it, to the element focused
   * when the modal mounted. Either only while still in the document. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** "cycle" wraps Tab through the surface; "pin" holds it on the
   * initial target. */
  trap?: "cycle" | "pin";
  /** Keys other than Escape and Tab, heard only while this modal is the
   * topmost. */
  onKey?: (event: KeyboardEvent) => void;
}

const open: object[] = [];
let overflowBeforeFirst = "";

function focusedOutside(surface: HTMLElement | null): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  return surface?.contains(active) ? null : active;
}

/** Modal behaviour for as long as the calling component is mounted. */
export function useModal({
  surfaceRef, initialFocusRef, onClose, triggerRef, trap = "cycle", onKey,
}: ModalOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;

  useEffect(() => {
    const entry = {};
    const restoreTo = triggerRef?.current
      ?? focusedOutside(surfaceRef.current);
    if (open.length === 0) {
      overflowBeforeFirst = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    open.push(entry);
    initialFocusRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (open[open.length - 1] !== entry) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === "Tab") {
        if (trap === "pin") {
          event.preventDefault();
          initialFocusRef.current?.focus();
          return;
        }
        const surface = surfaceRef.current;
        if (!surface) return;
        const active = document.activeElement;
        const target = focusWrapTarget(
          Array.from(surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)),
          active instanceof HTMLElement ? active : null,
          event.shiftKey,
        );
        if (target) {
          event.preventDefault();
          target.focus();
        }
      } else {
        onKeyRef.current?.(event);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      const wasTop = open[open.length - 1] === entry;
      open.splice(open.indexOf(entry), 1);
      if (open.length === 0) document.body.style.overflow = overflowBeforeFirst;
      if (wasTop && restoreTo?.isConnected) restoreTo.focus();
    };
  }, [surfaceRef, initialFocusRef, triggerRef, trap]);
}
