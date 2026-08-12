// pattern: Imperative Shell
// Uploaded-asset image. Viewed assets are runtime-cached by the service
// worker (spec section 5); one that was never viewed can't load offline,
// so a failed load renders a labelled placeholder instead of a broken img.
// Uploaded /assets/ images also expand fullscreen via the shared
// ImageOverlay (pkm-vcn6).
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOverlay } from "./ImageOverlay";

function isUploadedAsset(src: string): boolean {
  return src.startsWith("/assets/");
}

export function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // A new src deserves a fresh attempt and must not leave the old image open.
  useEffect(() => {
    setFailed(false);
    setExpanded(false);
  }, [src]);

  const close = useCallback(() => setExpanded(false), []);
  const onError = useCallback(() => {
    setExpanded(false);
    setFailed(true);
  }, []);

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
      {expanded && (
        <ImageOverlay src={src} alt={alt} onClose={close} onError={onError}
                      triggerRef={triggerRef} />
      )}
    </>
  );
}
