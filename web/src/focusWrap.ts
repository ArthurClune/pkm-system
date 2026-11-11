// pattern: Functional Core
// The focus trap's wrap rule and the elements it may land on, shared by every
// modal surface through useModal.

/** Everything a cycling focus trap can land on: links, enabled form controls
 * and explicit tab stops (the PDF overlay's scroll frame). */
export const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), '
  + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
