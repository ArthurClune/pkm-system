// pattern: Functional Core
// The phone keyboard bar: the keys it offers, who gets it, and where it
// sits. The iPhone's on-screen keyboard has no Tab and buries the brackets,
// so a strip above it stands in for those keys. A button press is fed to
// keyboardPolicy.decideEditorKey as the key it names, so each button does
// exactly what that key does on a hardware keyboard.
import type { TextSelection } from "./keyEdits";

export interface KeyboardBarKey {
  /** The glyph on the button. */
  label: string;
  /** The button's accessible name. */
  name: string;
  /** The KeyboardEvent.key the press stands for. */
  key: string;
  shiftKey: boolean;
}

const char = (c: string): KeyboardBarKey =>
  ({ label: c, name: c, key: c, shiftKey: false });

export const KEYBOARD_BAR_KEYS: readonly KeyboardBarKey[] = [
  { label: "→", name: "Indent", key: "Tab", shiftKey: false },
  { label: "←", name: "Outdent", key: "Tab", shiftKey: true },
  char("("), char(")"), char("["), char("]"),
];

/** An iPhone (or iPod touch), by user agent. Deliberately not a width
 * query: a narrow desktop window has a real Tab key, and an iPad (whose
 * Safari reports either "iPad" or a Mac) is usually used with a keyboard
 * and has its own shortcut bar. */
export function isPhoneUserAgent(ua: string): boolean {
  return /\b(iPhone|iPod)\b/.test(ua);
}

/** What typing `ch` does when the policy leaves it to the textarea: replace
 * the selection and put the caret after it. A bar press has no native
 * keystroke to fall back on, so the shell applies this instead. */
export function insertTypedChar(
  text: string, selStart: number, selEnd: number, ch: string,
): TextSelection {
  const caret = selStart + ch.length;
  return {
    text: text.slice(0, selStart) + ch + text.slice(selEnd),
    selStart: caret, selEnd: caret,
  };
}

/** How far up from the layout viewport's bottom the on-screen keyboard
 * reaches. iOS Safari doesn't shrink the layout viewport for the keyboard,
 * so a `position: fixed; bottom: 0` element sits behind it; only the visual
 * viewport (its height, and how far it has scrolled down the layout
 * viewport) says where the keyboard starts. */
export function keyboardInset(
  layoutHeight: number, visualHeight: number, visualOffsetTop: number,
): number {
  return Math.max(0, layoutHeight - visualHeight - visualOffsetTop);
}
