// pattern: Functional Core
// Pure text/caret transforms for editor keystrokes: bracket auto-pairing
// (typing one of [ ( { ` " ' ), Cmd-K markdown-link wrapping, and Cmd-B/Cmd-I
// emphasis toggling. Each returns the new textarea value plus the selection to
// restore afterwards, or null to let the keystroke fall through to the browser's
// default handling.
//
// These are intentionally stateless: "skip over an auto-inserted closing
// bracket" is inferred from "the next character already equals the one being
// typed", the same heuristic editors like VS Code use, rather than tracking
// which brackets we inserted.

export interface TextSelection {
  text: string;
  selStart: number;
  selEnd: number;
}

const OPEN_TO_CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
// Characters that are their own closer (opening === closing).
const SYMMETRIC = new Set(["`", '"', "'"]);
// Right-hand brackets that should "skip over" an existing match.
const CLOSERS = new Set(["]", ")", "}"]);
const WORD_RE = /\w/;

/** All characters that trigger bracket handling (so the caller can decide
 * whether a keystroke is even a candidate before consulting selection state). */
export const BRACKET_CHARS: ReadonlySet<string> = new Set([
  ...Object.keys(OPEN_TO_CLOSE), ...CLOSERS, ...SYMMETRIC,
]);

/** Auto-pair / wrap / skip-over behaviour for a single typed bracket-ish
 * character. Returns the resulting text+selection, or null when the keystroke
 * should be handled normally by the textarea. */
export function autoPairBracket(
  text: string, selStart: number, selEnd: number, char: string,
): TextSelection | null {
  const hasSelection = selStart !== selEnd;

  // Skip over a closing/symmetric char the user typed right before its match
  // (e.g. the auto-inserted "]" or the second quote of a pair). Only with no
  // selection — with a selection the char should replace it as usual.
  if (!hasSelection && (CLOSERS.has(char) || SYMMETRIC.has(char))
      && text[selStart] === char) {
    return { text, selStart: selStart + 1, selEnd: selStart + 1 };
  }

  const close = OPEN_TO_CLOSE[char] ?? (SYMMETRIC.has(char) ? char : undefined);
  if (close === undefined) return null; // a lone "]" etc. with nothing to skip

  if (hasSelection) {
    // Wrap the selection and keep the inner text selected so the user can keep
    // typing over it or nest another pair.
    const inner = text.slice(selStart, selEnd);
    const newText =
      text.slice(0, selStart) + char + inner + close + text.slice(selEnd);
    return { text: newText, selStart: selStart + 1, selEnd: selEnd + 1 };
  }

  // Don't auto-pair a quote that abuts a word char: that's an apostrophe
  // (don't, it's) or a closing quote after a word, not the start of a pair.
  if (SYMMETRIC.has(char)) {
    const prev = text[selStart - 1];
    if (prev !== undefined && WORD_RE.test(prev)) return null;
  }

  const newText = text.slice(0, selStart) + char + close + text.slice(selStart);
  return { text: newText, selStart: selStart + 1, selEnd: selStart + 1 };
}

/** Cmd-K: wrap the selection as a markdown link `[sel]()` with the caret placed
 * between the parens; with no selection insert an empty `[]()` with the caret
 * between the brackets, ready to type the link text. Always acts. */
export function wrapLink(
  text: string, selStart: number, selEnd: number,
): TextSelection {
  if (selStart !== selEnd) {
    const inner = text.slice(selStart, selEnd);
    const head = text.slice(0, selStart) + "[" + inner + "](";
    const newText = head + ")" + text.slice(selEnd);
    return { text: newText, selStart: head.length, selEnd: head.length };
  }
  const newText = text.slice(0, selStart) + "[]()" + text.slice(selStart);
  const caret = selStart + 1; // between the brackets
  return { text: newText, selStart: caret, selEnd: caret };
}

/** Cmd-B / Cmd-I: toggle an emphasis marker pair ("**" bold, "__" italic —
 * Roam-style, matching grammar/tokenize.ts) around the selection. A wrapped
 * selection (markers just outside, or included in the selection) unwraps;
 * anything else wraps, keeping the inner text selected so toggles stack and
 * a second press undoes. A bare caret inserts an empty pair with the caret
 * centered; pressed again there, it deletes the pair. Multi-line selections are
 * wrapped literally but will not render as emphasis (the tokenizer skips emphasis
 * spanning newlines) — deliberate, matching the "user gets what they selected" stance. */
export function toggleEmphasis(
  text: string, selStart: number, selEnd: number, marker: "**" | "__",
): TextSelection {
  const m = marker.length;
  const inner = text.slice(selStart, selEnd);

  if (selStart !== selEnd) {
    // Selection includes the markers: strip them, keep the inner selected.
    if (inner.length >= 2 * m && inner.startsWith(marker) && inner.endsWith(marker)) {
      const stripped = inner.slice(m, -m);
      return {
        text: text.slice(0, selStart) + stripped + text.slice(selEnd),
        selStart, selEnd: selStart + stripped.length,
      };
    }
    // Markers just outside the selection: remove them, keep it selected.
    if (selStart >= m && text.slice(selStart - m, selStart) === marker
        && text.slice(selEnd, selEnd + m) === marker) {
      return {
        text: text.slice(0, selStart - m) + inner + text.slice(selEnd + m),
        selStart: selStart - m, selEnd: selEnd - m,
      };
    }
    // Wrap, keeping the inner text selected (like autoPairBracket's wrap).
    return {
      text: text.slice(0, selStart) + marker + inner + marker + text.slice(selEnd),
      selStart: selStart + m, selEnd: selEnd + m,
    };
  }

  // Bare caret between an empty pair: delete the pair.
  if (selStart >= m && text.slice(selStart - m, selStart) === marker
      && text.slice(selStart, selStart + m) === marker) {
    return {
      text: text.slice(0, selStart - m) + text.slice(selStart + m),
      selStart: selStart - m, selEnd: selStart - m,
    };
  }
  // Bare caret: insert an empty pair with the caret centered.
  return {
    text: text.slice(0, selStart) + marker + marker + text.slice(selStart),
    selStart: selStart + m, selEnd: selStart + m,
  };
}
