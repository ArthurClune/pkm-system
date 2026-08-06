// pattern: Functional Core
// Viewport clamping for fixed-position popovers (pkm-7iv7). An anchor point
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
