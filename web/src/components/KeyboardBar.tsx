// pattern: Imperative Shell
// The phone keyboard bar's surface: a strip of keys pinned to the top of the
// on-screen keyboard. It owns only placement and taps. What a key does is
// the focused BlockInput's call (outline/keyboardBar.ts has the key list).
import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KEYBOARD_BAR_KEYS, keyboardInset,
         type KeyboardBarKey } from "../outline/keyboardBar";

/** The keyboard's height over the layout viewport, tracked live: the visual
 * viewport resizes as the keyboard opens and closes, and scrolls when iOS
 * pans the page to keep the caret in view. 0 where there is no
 * visualViewport (jsdom), which pins the bar to the bottom edge. */
function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useLayoutEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setInset(keyboardInset(
      document.documentElement.clientHeight, vv.height, vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}

// A tap must never move focus: the textarea losing it would close the
// keyboard, blur the block and end the edit. Cancelling pointerdown (and
// mousedown, for a browser that still sends one) keeps focus where it is.
// iOS WebKit then sends no click, so a tap acts on the pointerdown itself.
// A click with detail 0 has no pointer behind it (VoiceOver's double-tap)
// and acts on its own; a pointer's click (detail >= 1) already did.
const keepFocus = (e: React.SyntheticEvent) => e.preventDefault();

export function KeyboardBar({ onPress }: {
  onPress: (k: KeyboardBarKey) => void;
}) {
  const inset = useKeyboardInset();
  return createPortal(
    <div className="keyboard-bar" role="toolbar" aria-label="Editing keys"
         style={{ bottom: inset }}>
      {KEYBOARD_BAR_KEYS.map((k) => (
        <button key={k.name} type="button"
                className="btn-secondary keyboard-bar-key" tabIndex={-1}
                aria-label={k.name}
                onPointerDown={(e) => { keepFocus(e); onPress(k); }}
                onMouseDown={keepFocus}
                onClick={(e) => { if (e.detail === 0) onPress(k); }}>
          {k.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
