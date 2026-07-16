// pattern: Functional Core
// Pure helpers for the PDF viewer: which page the scroll position is "on"
// (from IntersectionObserver visible fractions) and how tall an unrendered
// page placeholder should be, so scrollbar geometry is close to final
// before pages rasterize.

/** Portrait page aspect (height/width) assumed until page 1's real
 * dimensions are known: ISO A-series sqrt(2). */
export const DEFAULT_PAGE_ASPECT = Math.SQRT2;

/** The page the indicator should report: largest visible fraction wins,
 * ties go to the earliest page, and 1 when nothing is measured yet. */
export function currentPageFromRatios(
  ratios: ReadonlyMap<number, number>,
): number {
  let best = 1;
  let bestRatio = 0;
  for (const [page, ratio] of ratios) {
    if (ratio > bestRatio || (ratio > 0 && ratio === bestRatio && page < best)) {
      best = page;
      bestRatio = ratio;
    }
  }
  return best;
}

/** Focus-trap wrap decision: the element Tab/Shift+Tab should move to, or
 * null when the browser's natural tab order already stays inside the trap.
 * An active element outside the list (or none) pulls focus back inside. */
export function focusWrapTarget<T>(
  focusables: readonly T[],
  active: T | null,
  shiftKey: boolean,
): T | null {
  if (focusables.length === 0) return null;
  const i = active === null ? -1 : focusables.indexOf(active);
  if (shiftKey) return i <= 0 ? focusables[focusables.length - 1] : null;
  return i === -1 || i === focusables.length - 1 ? focusables[0] : null;
}

/** Height (CSS px) for a page slot whose canvas hasn't rendered yet. */
export function placeholderHeight(
  width: number,
  aspect: number | null,
): number {
  if (!Number.isFinite(width)) return 1;
  return Math.max(1, Math.round(width * (aspect ?? DEFAULT_PAGE_ASPECT)));
}
