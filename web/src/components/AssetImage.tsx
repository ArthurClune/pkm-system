// pattern: Functional Core
// Uploaded-asset image. Viewed assets are runtime-cached by the service
// worker (spec section 5); one that was never viewed can't load offline,
// so a failed load renders a labelled placeholder instead of a broken img.
import { useEffect, useState } from "react";

export function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  // a new src deserves a fresh attempt (e.g. re-render after reconnect)
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <span className="asset-image-placeholder" role="note">
        image unavailable offline{alt ? `: ${alt}` : ""}
      </span>
    );
  }
  return <img className="asset-image" src={src} alt={alt} loading="lazy"
              onError={() => setFailed(true)} />;
}
