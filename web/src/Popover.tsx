// pattern: Imperative Shell
// The chrome shared by every anchored popover (pkm-2i6a): a labelled dialog
// at a fixed position, measured after layout and clamped into the viewport
// (popoverPosition.ts), dismissed by Escape or an outside mousedown
// (useDismiss.ts). Mouse/touch-only by the accepted popover convention
// (pkm-3w2h) — there is no focus trap and nothing steals focus on open.
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { clampPopoverPosition } from "./popoverPosition";
import { useDismiss } from "./useDismiss";

/** Distance kept between the popover and every viewport edge. */
const VIEWPORT_MARGIN = 12;

export function Popover({ label, x, y, onClose, remeasure, children }: {
  /** The dialog's accessible name. */
  label: string;
  x: number;
  y: number;
  onClose: () => void;
  /** The one thing callers differ on: which of their values, when they
   * change, resize the content and so invalidate the clamp — a loading
   * placeholder swapping for rows, an error line appearing. Re-renders the
   * caller does not declare here are deliberately NOT re-measured, so a
   * popover cannot drift under the pointer for cosmetic reasons.
   *
   * Pass a fixed-length array: it is spread into the effect's dependency
   * list, so its length must not vary between renders of one popover. */
  remeasure: readonly unknown[];
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  // An anchor is a wish: a badge at the right end of a long row would put a
  // 260-480px popover past the window edge, and position:fixed grows no
  // scrollbar to recover it (pkm-7iv7). Measure after layout, then clamp.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(clampPopoverPosition({
      x, y, width: rect.width, height: rect.height,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      margin: VIEWPORT_MARGIN,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, ...remeasure]);

  useDismiss(ref, onClose, { preventDefaultOnEscape: true });

  // Portalled to document.body (pkm-muka), never rendered in place: the
  // clamp above is in viewport coordinates, and `position: fixed` only
  // resolves against the viewport while no ancestor imposes layout
  // containment (`content-visibility`, `contain: layout`). Inside such a
  // box this popover would paint displaced by that box's own offset --
  // 283x471px when `content-visibility: auto` was trialled on
  // `.journal-day` and rejected on the numbers. The invariant, not the one
  // rule, is what matters: see "Nothing `position: fixed` may render inside
  // a layout-contained box" in docs/architecture/styling.md.
  // Dismissal is unaffected: useDismiss's `contains` check is against this
  // element itself, and React still propagates synthetic events from here
  // through the REACT tree to whatever rendered the popover (the hazard
  // PdfViewer.tsx documents), so callers keep their own containment.
  return createPortal(
    <div className="block-ref-popover" role="dialog" aria-label={label}
         ref={ref} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>,
    document.body,
  );
}
