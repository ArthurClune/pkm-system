// pattern: Imperative Shell
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { tocFloatRoom } from "./components/tocFloat";

function contentWidth(pane: HTMLElement): number {
  const style = getComputedStyle(pane);
  return pane.clientWidth - (parseFloat(style.paddingLeft) || 0)
    - (parseFloat(style.paddingRight) || 0);
}

/** Whether the main pane has room for a floating toc. Only a changed
 * answer is set: React may render once more for a same-value setState,
 * and App's whole tree hangs off this. The
 * pane is measured rather than the window: collapsing the left nav widens
 * it as much as resizing does. */
export function useTocFloatRoom(pane: RefObject<HTMLElement | null>,
                                sidebarOpen: boolean): boolean {
  const [room, setRoom] = useState(false);
  const roomRef = useRef(room);
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return undefined;
    const measure = () => {
      const next = tocFloatRoom(sidebarOpen, contentWidth(el));
      if (next === roomRef.current) return;
      roomRef.current = next;
      setRoom(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [pane, sidebarOpen]);
  return room;
}
