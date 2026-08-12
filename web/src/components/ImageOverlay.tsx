// pattern: Imperative Shell
// Fullscreen overlay for uploaded images, extracted from AssetImage
// (pkm-vcn6) so the /files browser can share it. Owns the body scroll
// lock, Escape-to-close, Tab pinned to the Close button, and focus
// restore to the trigger on unmount.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function ImageOverlay({ src, alt, onClose, onError, triggerRef }: {
  src: string;
  alt: string;
  onClose: () => void;
  /** The overlay image failed to load; caller closes and marks broken. */
  onError: () => void;
  /** Focus returns here when the overlay unmounts. */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const trigger = triggerRef?.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
  }, [onClose, triggerRef]);

  const dialogLabel = alt ? `Expanded image: ${alt}` : "Expanded image";
  return createPortal(
    <div
      className="image-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="image-overlay-bar">
        <button
          type="button"
          className="btn-secondary"
          ref={closeRef}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div
        className="image-overlay-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <img
          className="image-overlay-image"
          src={src}
          alt={alt}
          onError={onError}
        />
      </div>
    </div>,
    document.body,
  );
}
