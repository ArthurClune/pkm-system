// pattern: Functional Core
// Viewport clamping for fixed-position popovers. An anchor point
// is a wish, not a contract: a badge at the right end of a long row would
// otherwise push its popover off-screen, and position:fixed means the page
// grows no scrollbar to recover it.

export function clampPopoverPosition({ x, y, width, height,
                                       viewportWidth, viewportHeight, margin }: {
  x: number; y: number; width: number; height: number;
  viewportWidth: number; viewportHeight: number; margin: number;
}): { x: number; y: number } {
  // Math.max last: when the popover is bigger than the viewport, pinning the
  // top-left inside the margin keeps its scrollable start reachable.
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}

/** Under `anchor` when the popover fits there, above it when only that
 * fits, then clamped. Clamping alone would push a popover under a field
 * near the viewport's bottom (an iPad with its keyboard up) back over the
 * field it serves. */
export function placeUnderAnchor({ anchor, width, height, viewportWidth,
                                   viewportHeight, margin, gap }: {
  anchor: { left: number; top: number; bottom: number };
  width: number; height: number;
  viewportWidth: number; viewportHeight: number; margin: number; gap: number;
}): { x: number; y: number } {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const flip = below + height + margin > viewportHeight && above >= margin;
  return clampPopoverPosition({
    x: anchor.left, y: flip ? above : below, width, height,
    viewportWidth, viewportHeight, margin,
  });
}
