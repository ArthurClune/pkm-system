// pattern: Imperative Shell
// Fullscreen overlay for uploaded images, extracted from AssetImage
// so the /files browser can share it. Body scroll lock,
// Escape-to-close, Tab pinned to Close and focus restore to the trigger
// come from useModal.
import { useRef } from "react";
import { createPortal } from "react-dom";
import { useModal } from "../useModal";

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
  const surfaceRef = useRef<HTMLDivElement>(null);
  useModal({
    surfaceRef, initialFocusRef: closeRef, onClose, triggerRef, trap: "pin",
  });

  const dialogLabel = alt ? `Expanded image: ${alt}` : "Expanded image";
  return createPortal(
    <div
      className="image-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={dialogLabel}
      ref={surfaceRef}
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
