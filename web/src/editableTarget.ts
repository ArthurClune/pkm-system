// pattern: Functional Core

/** Whether a key event's target is a text field that owns its own keys:
 * an input, a textarea or contentEditable. A window or tree shortcut that
 * would act on something else leaves these alone. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

/** Set by `island` on a table surface's root. */
export const TABLE_ISLAND_ATTR = "data-table-island";

/** Whether a key event's target sits inside a table surface (a focused
 * cell, a sort button, the filter). The island passes Cmd and Ctrl chords
 * on for window shortcuts, so a tree shortcut must skip them itself. */
export function isInTableIsland(target: EventTarget | null): boolean {
  return target instanceof Element
    && target.closest(`[${TABLE_ISLAND_ATTR}]`) !== null;
}
