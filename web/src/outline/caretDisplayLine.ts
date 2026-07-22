// pattern: Imperative Shell
// Measures which VISUAL (display) line a textarea's caret sits on, so plain
// ArrowUp/Down in a soft-wrapped block (no "\n", multiple rendered lines) can
// tell keyboardPolicy.ts apart from a genuinely-single-line caret at the
// block's logical edge (pkm-2867). The functional core has no DOM access and
// cannot see wrapping, hence this lives in the shell.
//
// jsdom has no layout engine (clientHeight/offsetTop always read 0), so this
// module is exercised by e2e, not unit tests; it must fail closed (return
// null) whenever it can't get real measurements, so the core's `!== false`
// check falls back to its old newline-only behaviour.

const MIRROR_STYLE_PROPS = [
  "box-sizing", "width", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width", "font-family", "font-size",
  "font-weight", "font-style", "letter-spacing", "line-height", "tab-size",
  "word-break", "overflow-wrap",
];

/** Whether `pos` (a caret offset into `el.value`) sits on the first and/or
 * last rendered line of the textarea. Returns null if unmeasurable. */
export function measureCaretDisplayLine(
  el: HTMLTextAreaElement, pos: number,
): { first: boolean; last: boolean } | null {
  const text = el.value;
  const cs = getComputedStyle(el);
  const lineHeight = parseFloat(cs.lineHeight);
  const paddingTop = parseFloat(cs.paddingTop) || 0;
  const paddingBottom = parseFloat(cs.paddingBottom) || 0;
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) return null;
  const contentHeight = el.clientHeight - paddingTop - paddingBottom;
  if (contentHeight <= 0) return null; // not laid out (e.g. jsdom, hidden)

  // Fast path: content fits on one visual line, so any caret position is on
  // both the first and last line — skip building the mirror entirely.
  if (contentHeight <= lineHeight * 1.5) return { first: true, last: true };

  // Past this point wrapping is confirmed, so the absolute text boundaries
  // are unambiguous without measuring: offset 0 is always the first visual
  // line, and the end of the text is always the last.
  if (pos <= 0) return { first: true, last: false };
  if (pos >= text.length) return { first: false, last: true };

  const mirror = buildMirror(cs);
  const before = document.createTextNode(text.slice(0, pos));
  const marker = document.createElement("span");
  marker.textContent = "​"; // zero-width sentinel keeps the span on a line
  const after = document.createTextNode(text.slice(pos));
  mirror.append(before, marker, after);
  document.body.appendChild(mirror);
  try {
    const markerTop = marker.offsetTop;
    const markerHeight = marker.offsetHeight || lineHeight;
    const totalHeight = mirror.scrollHeight;
    const half = lineHeight / 2;
    if (mirror.clientWidth <= 0 || totalHeight <= 0) return null;
    return {
      first: markerTop < half,
      last: totalHeight - (markerTop + markerHeight) < half,
    };
  } finally {
    mirror.remove();
  }
}

function buildMirror(cs: CSSStyleDeclaration): HTMLDivElement {
  const mirror = document.createElement("div");
  const style = mirror.style;
  for (const prop of MIRROR_STYLE_PROPS) {
    style.setProperty(prop, cs.getPropertyValue(prop));
  }
  style.position = "absolute";
  style.visibility = "hidden";
  style.top = "0";
  style.left = "-9999px";
  style.whiteSpace = "pre-wrap";
  style.wordWrap = "break-word";
  return mirror;
}
