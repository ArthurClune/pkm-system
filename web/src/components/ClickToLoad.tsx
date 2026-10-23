// pattern: Imperative Shell
// The one gate for media that would fetch on render. Until a click, it
// renders a placeholder naming the media; only the click mounts `children`.
// Creating the children element does not mount it, so a component that
// fetches from its render, its effects or its commit (an img, an iframe, a
// handle lookup, a diagram renderer) stays unmounted until then.
//
// The guarantee is the comparison during render: children mount only while
// the revealed key equals the current `revealKey`. A new key therefore never
// commits its media without its own click. A "was clicked" flag reset in an
// effect would commit one frame for the new key first, and the fetch starts
// at commit. The render-time reset only clears the state, so returning to an
// earlier key needs a new click.
//
// The click stops propagating: the placeholder sits inside block text, block
// refs and backlink rows, whose own click handlers would otherwise enter edit
// mode or navigate. A reveal from a focused placeholder (Enter, Space, or a
// click that focused it) moves focus to the wrapper around the revealed
// media, because unmounting the focused button would drop focus to <body>.
// Inside InertMediaContext (a row whose whole surface is the click target)
// the placeholder is plain text.
//
// Callers decide when to gate; this file decides only how.
import { type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import { InertMediaContext } from "../contexts";

type Revealed = { key: string; focus: boolean };

export function ClickToLoad({ revealKey, label, preview, children }: {
  revealKey: string;
  label: string;
  // Shown above the placeholder until the click, for example a diagram's
  // source; never shown once revealed.
  preview?: ReactNode;
  children: ReactNode;
}) {
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const inertMedia = useContext(InertMediaContext);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  if (revealed !== null && revealed.key !== revealKey) setRevealed(null);
  const shown = revealed !== null && revealed.key === revealKey;

  useLayoutEffect(() => {
    if (shown && revealed.focus) wrapperRef.current?.focus();
  }, [shown, revealed]);

  if (shown) {
    return (
      <span className="click-to-load-revealed" tabIndex={-1} ref={wrapperRef}>
        {children}
      </span>
    );
  }
  const className = "asset-image-placeholder external-media-placeholder";
  if (inertMedia) return <>{preview}<span className={className}>{label}</span></>;
  return (
    <>
      {preview}
      <button
        type="button"
        className={className}
        onClick={(event) => {
          event.stopPropagation();
          const focus = document.activeElement === event.currentTarget;
          setRevealed({ key: revealKey, focus });
        }}
      >
        {label}
      </button>
    </>
  );
}
