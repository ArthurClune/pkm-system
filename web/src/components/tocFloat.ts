// pattern: Functional Core

/** Main-pane content width a floating toc needs: the 220px column and
 * 32px gap of `.outline-with-toc` in styles.css, plus a reading column of
 * about 600px. Change the stylesheet's numbers and this together. */
export const FLOATING_TOC_MIN_PANE_PX = 860;

/** The right sidebar takes priority: while it is open nothing floats. */
export function tocFloatRoom(sidebarOpen: boolean,
                             paneContentWidth: number): boolean {
  return !sidebarOpen && paneContentWidth >= FLOATING_TOC_MIN_PANE_PX;
}
