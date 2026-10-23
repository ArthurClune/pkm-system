// pattern: Functional Core
// Which way the approval card's hint points. Allow waits until a marker
// before the card's heading and one after its last op have each been in
// view. A marker not yet seen lies above or below what the transcript shows:
// in a window too short for the list and its heading, scrolling the
// transcript to its end carries the end marker past its top, and "scroll to
// the end" would then send the user the wrong way.

export type MarkerState = "seen" | "above" | "below";

type Span = { top: number; bottom: number };

/** Where an unseen `marker` lies against the transcript's `view`, or null
 * when the view has no height to compare with (no layout). A marker inside
 * the view's band is hidden by the list's own region, which has to scroll
 * further down, so it counts as below. */
export function placeOf(marker: Span, view: Span): "above" | "below" | null {
  if (!(view.bottom > view.top)) return null;
  return marker.bottom <= view.top ? "above" : "below";
}

/** The hint for the markers' states, the end first, or null once both have
 * been seen. */
export function confirmHint(start: MarkerState, end: MarkerState): string | null {
  if (end === "above") return "Scroll up to bring the end of the list into view";
  if (end === "below") return "Scroll to the end to review every write";
  if (start === "above") return "Scroll back to the start to review every write";
  if (start === "below") {
    return "Scroll down to the start of the card to review every write";
  }
  return null;
}
