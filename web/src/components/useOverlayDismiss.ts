// pattern: Imperative Shell
// Shared modal-overlay behaviour: body scroll lock, Escape closes in the
// capture phase (so hosts that also close on Escape never see it), Tab is
// pinned to the Close button, and focus returns to the trigger on unmount.
// Extracted from ImageOverlay so the GoodLinks reader behaves identically.
import { useEffect, type RefObject } from "react";

export function useOverlayDismiss(
  closeRef: RefObject<HTMLButtonElement | null>,
  onClose: () => void,
  triggerRef?: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    const trigger = triggerRef?.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Capture-phase trap: hosts (e.g. the assistant panel) also close on
        // Escape, and portal events still bubble through the React tree, so
        // the Escape that dismisses the overlay must never reach them.
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [closeRef, onClose, triggerRef]);
}
