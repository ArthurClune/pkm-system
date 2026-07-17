// pattern: Imperative Shell
// Uploaded-asset image. Viewed assets are runtime-cached by the service
// worker (spec section 5); one that was never viewed can't load offline,
// so a failed load renders a labelled placeholder instead of a broken img.
// Uploaded /assets/ images also own an accessible fullscreen expansion
// overlay; both behaviors coordinate React state and DOM effects.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function isUploadedAsset(src: string): boolean {
  return src.startsWith("/assets/");
}

export function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A new src deserves a fresh attempt and must not leave the old image open.
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [src]);

  useEffect(() => {
    if (!expanded) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
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
  }, [expanded]);

  const onError = () => {
    setExpanded(false);
    setFailed(true);
  };

  if (failed) {
    return (
      <span className="asset-image-placeholder" role="note">
        image unavailable offline{alt ? `: ${alt}` : ""}
      </span>
    );
  }

  const inlineImage = (
    <img className="asset-image" src={src} alt={alt} loading="lazy" onError={onError} />
  );
  if (!isUploadedAsset(src)) return inlineImage;

  const triggerLabel = alt ? `Expand image: ${alt}` : "Expand image";
  const dialogLabel = alt ? `Expanded image: ${alt}` : "Expanded image";

  return (
    <>
      <button
        type="button"
        className="asset-image-trigger"
        aria-label={triggerLabel}
        ref={triggerRef}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded(true);
        }}
      >
        {inlineImage}
      </button>
      {expanded && createPortal(
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
              onClick={() => setExpanded(false)}
            >
              Close
            </button>
          </div>
          <div
            className="image-overlay-stage"
            onClick={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
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
      )}
    </>
  );
}
