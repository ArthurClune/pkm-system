// pattern: Functional Core
// Pure helpers for the PDF viewer: which page the scroll position is "on"
// (from IntersectionObserver visible fractions), which pages stay mounted
// around it, and how tall an unrendered page placeholder should be, so
// scrollbar geometry is close to final before pages rasterize.

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

/** The pages that should stay mounted: every page within `radius` of one the
 * observer reports near the viewport, clamped to the document. Page 1 is the
 * floor: no observer has fired yet, or every near page is outside the
 * document (a stale set from a longer document), still mounts page 1 rather
 * than nothing.
 *
 * This is what bounds the viewer's memory. Mounting pages as they approach
 * and never unmounting them meant a long document scrolled end to end held
 * every rasterized canvas at once. */
export function mountedPageWindow(
  near: Iterable<number>,
  total: number,
  radius: number,
): Set<number> {
  const keep = new Set<number>();
  for (const page of near) {
    if (page < 1 || page > total) continue;
    const from = Math.max(1, page - radius);
    const to = Math.min(total, page + radius);
    for (let p = from; p <= to; p++) keep.add(p);
  }
  if (keep.size === 0) keep.add(1);
  return keep;
}

/** `pages` narrowed to those in `keep`, or `pages` itself when it already
 * is. Returning the same object keeps an unchanged set out of setState. */
export function retainPages(
  pages: ReadonlySet<number>,
  keep: ReadonlySet<number>,
): ReadonlySet<number> {
  let dropping = false;
  for (const p of pages) {
    if (!keep.has(p)) {
      dropping = true;
      break;
    }
  }
  if (!dropping) return pages;
  const next = new Set<number>();
  for (const p of pages) if (keep.has(p)) next.add(p);
  return next;
}

/** Height (CSS px) for a page slot whose canvas hasn't rendered yet. */
export function placeholderHeight(
  width: number,
  aspect: number | null,
): number {
  if (!Number.isFinite(width)) return 1;
  return Math.max(1, Math.round(width * (aspect ?? DEFAULT_PAGE_ASPECT)));
}
