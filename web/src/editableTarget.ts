// pattern: Functional Core

/** Whether a key event's target is a text field that owns its own keys:
 * an input, a textarea or contentEditable. A window or tree shortcut that
 * would act on something else leaves these alone. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable);
}
