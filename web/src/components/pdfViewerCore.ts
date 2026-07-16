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

/** Height (CSS px) for a page slot whose canvas hasn't rendered yet. */
export function placeholderHeight(
  width: number,
  aspect: number | null,
): number {
  return Math.max(1, Math.round(width * (aspect ?? DEFAULT_PAGE_ASPECT)));
}
