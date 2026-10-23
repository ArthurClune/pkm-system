// pattern: Imperative Shell
// An image in rendered markdown. Only an uploaded /assets/ image loads on
// render; any other src waits behind ClickToLoad, keyed by src. An image URL
// is an outbound channel: the browser fetches it at commit, so anything that
// can write markdown the app renders, the assistant included, could otherwise
// send note text to any host with no click.
//
// LoadedImage renders the img itself. Viewed assets are runtime-cached by the
// service worker (offline-editing-design.md §5); one that was never viewed
// can't load offline, so a failed load renders a labelled placeholder instead
// of a broken img.
// Until the image loads or fails it has no size, and on a stalled connection
// that can take as long as the network's own timeout: a pending placeholder
// fills the gap so the block never reads as an empty bullet. Uploaded /assets/
// images also expand fullscreen via the shared ImageOverlay. Inside
// InertMediaContext (popover rows whose whole row is the click target) the
// expand trigger is skipped and the image renders inline only.
import { useCallback, useContext, useLayoutEffect, useRef, useState } from "react";
import { InertMediaContext } from "../contexts";
import { ClickToLoad } from "./ClickToLoad";
import { externalImageLabel, isUploadedAsset } from "./externalMedia";
import { ImageOverlay } from "./ImageOverlay";

type LoadState = "pending" | "loaded" | "failed";

function LoadedImage({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<LoadState>("pending");
  const [expanded, setExpanded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const inertMedia = useContext(InertMediaContext);

  // A new src deserves a fresh attempt and must not leave the old image open.
  // An image the browser already holds decoded is complete before paint, so
  // it starts loaded and the pending placeholder never flashes.
  useLayoutEffect(() => {
    const img = imgRef.current;
    setState(img?.complete && img.naturalWidth > 0 ? "loaded" : "pending");
    setExpanded(false);
  }, [src]);

  const close = useCallback(() => setExpanded(false), []);
  const onLoad = useCallback(() => setState("loaded"), []);
  const onError = useCallback(() => {
    setExpanded(false);
    setState("failed");
  }, []);

  const suffix = alt ? `: ${alt}` : "";
  if (state === "failed") {
    return (
      <span className="asset-image-placeholder" role="note">
        image unavailable offline{suffix}
      </span>
    );
  }

  // aria-hidden: the img's own alt already names it to assistive tech.
  const pending = state === "pending" && (
    <span className="asset-image-placeholder asset-image-pending" aria-hidden="true">
      loading image{suffix}
    </span>
  );
  const inlineImage = (
    <img className="asset-image" src={src} alt={alt} loading="lazy" ref={imgRef}
         onLoad={onLoad} onError={onError} />
  );
  if (!isUploadedAsset(src) || inertMedia) return <>{pending}{inlineImage}</>;

  const triggerLabel = alt ? `Expand image: ${alt}` : "Expand image";

  return (
    <>
      {pending}
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

export function AssetImage({ src, alt }: { src: string; alt: string }) {
  if (isUploadedAsset(src)) return <LoadedImage src={src} alt={alt} />;
  return (
    <ClickToLoad revealKey={src} label={externalImageLabel(src, alt)}>
      <LoadedImage src={src} alt={alt} />
    </ClickToLoad>
  );
}
