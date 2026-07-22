import { describe, expect, it } from "vitest";
import { decideEditorKey, type EditorKeyInput } from "./keyboardPolicy";

const input = (over: Partial<EditorKeyInput>): EditorKeyInput => ({
  key: "",
  code: "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  selStart: 0,
  selEnd: 0,
  draft: "",
  readOnly: false,
  acRowsLength: 0,
  acSelected: 0,
  ...over,
});

describe("decideEditorKey autocomplete precedence", () => {
  it("moves the selection down, clamped to the last row", () => {
    expect(decideEditorKey(input({ key: "ArrowDown", acRowsLength: 3, acSelected: 1 })))
      .toEqual({ type: "ac-move", selected: 2 });
    expect(decideEditorKey(input({ key: "ArrowDown", acRowsLength: 3, acSelected: 2 })))
      .toEqual({ type: "ac-move", selected: 2 });
  });

  it("moves the selection up, clamped to the first row", () => {
    expect(decideEditorKey(input({ key: "ArrowUp", acRowsLength: 3, acSelected: 1 })))
      .toEqual({ type: "ac-move", selected: 0 });
    expect(decideEditorKey(input({ key: "ArrowUp", acRowsLength: 3, acSelected: 0 })))
      .toEqual({ type: "ac-move", selected: 0 });
  });

  it("picks the current row on Enter or Tab", () => {
    expect(decideEditorKey(input({ key: "Enter", acRowsLength: 2 })))
      .toEqual({ type: "ac-pick" });
    expect(decideEditorKey(input({ key: "Tab", acRowsLength: 2 })))
      .toEqual({ type: "ac-pick" });
  });

  it("closes the popup on Escape while it is open", () => {
    expect(decideEditorKey(input({ key: "Escape", acRowsLength: 2 })))
      .toEqual({ type: "ac-close" });
  });

  it("leaves Option/Alt+ArrowUp and ArrowDown to the platform even with rows open", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", altKey: true, acRowsLength: 3, acSelected: 1,
    }))).toEqual({ type: "none" });
    expect(decideEditorKey(input({
      key: "ArrowDown", altKey: true, acRowsLength: 3, acSelected: 1,
    }))).toEqual({ type: "none" });
  });

  it("falls through to normal handling for keys the popup ignores", () => {
    // Enter is a split once the popup is closed, not an ac-pick.
    expect(decideEditorKey(input({ key: "Enter", acRowsLength: 0 })))
      .toEqual({ type: "split", cursor: 0 });
  });
});

describe("decideEditorKey Escape / navigation", () => {
  it("blurs on Escape with no popup", () => {
    expect(decideEditorKey(input({ key: "Escape" }))).toEqual({ type: "blur" });
  });

  it("navigates when Ctrl-O fires inside a page reference", () => {
    expect(decideEditorKey(input({
      key: "o", ctrlKey: true, draft: "see [[Target]]", selStart: 8, selEnd: 8,
    }))).toEqual({ type: "navigate-ref", title: "Target" });
  });

  it("leaves Ctrl-O alone when the caret is not inside a reference", () => {
    expect(decideEditorKey(input({
      key: "o", ctrlKey: true, draft: "plain text", selStart: 2, selEnd: 2,
    }))).toEqual({ type: "none" });
  });

  it("ignores Ctrl-O when Meta or Alt is also held", () => {
    expect(decideEditorKey(input({
      key: "o", ctrlKey: true, metaKey: true, draft: "[[Target]]", selStart: 3,
      selEnd: 3,
    }))).toEqual({ type: "none" });
  });
});

describe("decideEditorKey block selection", () => {
  it("starts an upward selection at the top edge with a collapsed caret", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, draft: "one\ntwo", selStart: 2, selEnd: 2,
    }))).toEqual({ type: "start-block-selection", dir: "up" });
  });

  it("starts a downward selection at the bottom edge", () => {
    expect(decideEditorKey(input({
      key: "ArrowDown", shiftKey: true, draft: "one\ntwo", selStart: 5,
      selEnd: 5,
    }))).toEqual({ type: "start-block-selection", dir: "down" });
  });

  it("does not start a selection away from the edge", () => {
    // A newline above the caret means Shift+ArrowUp extends within the block.
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, draft: "one\ntwo", selStart: 5, selEnd: 5,
    }))).toEqual({ type: "none" });
  });

  it("does not start a selection with a non-collapsed caret", () => {
    // A selection means Shift+ArrowUp is not a block-selection start; it falls
    // through to the ordinary first-line arrow behaviour (as the original did).
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, draft: "one", selStart: 0, selEnd: 2,
    }))).toEqual({ type: "arrow", dir: "up" });
  });

  it("still allows block selection while read-only", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, draft: "x", selStart: 0, selEnd: 0,
      readOnly: true,
    }))).toEqual({ type: "start-block-selection", dir: "up" });
  });
});

describe("decideEditorKey subtree move (pkm-hx2w)", () => {
  it("moves the subtree on Shift+Cmd+ArrowUp/Down", () => {
    expect(decideEditorKey(input({ key: "ArrowUp", shiftKey: true, metaKey: true })))
      .toEqual({ type: "move-subtree-up" });
    expect(decideEditorKey(input({ key: "ArrowDown", shiftKey: true, metaKey: true })))
      .toEqual({ type: "move-subtree-down" });
  });

  it("takes precedence over plain Shift+Arrow block-selection start", () => {
    // Same edge-of-block draft/caret that would otherwise start a selection.
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, metaKey: true, draft: "one\ntwo",
      selStart: 2, selEnd: 2,
    }))).toEqual({ type: "move-subtree-up" });
  });

  it("leaves plain Shift+Arrow (no Meta) starting a selection, unaffected", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, draft: "one\ntwo", selStart: 2, selEnd: 2,
    }))).toEqual({ type: "start-block-selection", dir: "up" });
  });

  it("leaves every Option/Alt+Arrow variant to the platform", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(decideEditorKey(input({ key, altKey: true })))
        .toEqual({ type: "none" });
      expect(decideEditorKey(input({
        key, altKey: true, shiftKey: true, metaKey: true,
      }))).toEqual({ type: "none" });
    }
  });

  it("is suppressed while read-only", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, metaKey: true, readOnly: true,
    }))).toEqual({ type: "none" });
  });

  it("ignores the chord when Ctrl or Alt is also held", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, metaKey: true, ctrlKey: true,
    }))).not.toEqual({ type: "move-subtree-up" });
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, metaKey: true, altKey: true,
    }))).not.toEqual({ type: "move-subtree-up" });
  });
});

describe("decideEditorKey read-only cutoff", () => {
  it("suppresses editing chords when read-only", () => {
    for (const over of [
      { key: "Enter" },
      { key: "Tab" },
      { key: "Backspace", selStart: 0, selEnd: 0 },
      { key: "k", metaKey: true },
      { key: "[" },
      { key: "1", code: "Digit1", ctrlKey: true, altKey: true },
    ] as Partial<EditorKeyInput>[]) {
      expect(decideEditorKey(input({ ...over, readOnly: true })))
        .toEqual({ type: "none" });
    }
  });

  it("still blurs on Escape while read-only", () => {
    expect(decideEditorKey(input({ key: "Escape", readOnly: true })))
      .toEqual({ type: "blur" });
  });
});

describe("decideEditorKey heading chord", () => {
  it("sets a heading level from Ctrl+Alt+Digit", () => {
    expect(decideEditorKey(input({
      key: "2", code: "Digit2", ctrlKey: true, altKey: true,
    }))).toEqual({ type: "set-heading", heading: 2 });
  });

  it("clears the heading for Ctrl+Alt+0", () => {
    expect(decideEditorKey(input({
      key: "0", code: "Digit0", ctrlKey: true, altKey: true,
    }))).toEqual({ type: "set-heading", heading: null });
  });

  it("resolves the digit from key when code is unavailable", () => {
    expect(decideEditorKey(input({
      key: "3", code: "", ctrlKey: true, altKey: true,
    }))).toEqual({ type: "set-heading", heading: 3 });
  });
});

describe("decideEditorKey text edits", () => {
  it("wraps a markdown link on Cmd-K", () => {
    const decision = decideEditorKey(input({
      key: "k", metaKey: true, draft: "word", selStart: 0, selEnd: 4,
    }));
    expect(decision).toEqual({
      type: "key-edit",
      edit: { text: "[word]()", selStart: 7, selEnd: 7 },
    });
  });

  it("auto-pairs a bracket", () => {
    const decision = decideEditorKey(input({
      key: "[", draft: "", selStart: 0, selEnd: 0,
    }));
    expect(decision).toEqual({
      type: "key-edit",
      edit: { text: "[]", selStart: 1, selEnd: 1 },
    });
  });

  it("does not intercept a bracket that has nothing to do", () => {
    // A lone closer with no match falls through to the browser.
    expect(decideEditorKey(input({ key: "]", draft: "", selStart: 0, selEnd: 0 })))
      .toEqual({ type: "none" });
  });
});

describe("decideEditorKey structural keys", () => {
  it("splits at the caret on Enter", () => {
    expect(decideEditorKey(input({ key: "Enter", selStart: 3, selEnd: 3 })))
      .toEqual({ type: "split", cursor: 3 });
  });

  it("does not split on Shift+Enter", () => {
    expect(decideEditorKey(input({ key: "Enter", shiftKey: true })))
      .toEqual({ type: "none" });
  });

  it("cycles the TODO marker on Cmd-Enter or Ctrl-Enter, as a key-edit on the live draft", () => {
    // "buy milk" -> "{{TODO}} buy milk": the 9-char prefix shifts the caret
    // by the same amount, so it stays next to the same character (after "buy").
    expect(decideEditorKey(input({
      key: "Enter", metaKey: true, draft: "buy milk", selStart: 3, selEnd: 3,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "{{TODO}} buy milk", selStart: 12, selEnd: 12 },
    });
    // TODO -> DONE keeps the same length, so the caret does not move.
    expect(decideEditorKey(input({
      key: "Enter", ctrlKey: true, draft: "{{TODO}} buy milk", selStart: 12, selEnd: 12,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "{{DONE}} buy milk", selStart: 12, selEnd: 12 },
    });
    // DONE -> plain: the caret shifts back by the same 9-char delta and is
    // clamped to the (shorter) new text.
    expect(decideEditorKey(input({
      key: "Enter", metaKey: true, draft: "{{DONE}} buy milk", selStart: 12, selEnd: 12,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "buy milk", selStart: 3, selEnd: 3 },
    });
  });

  it("does not cycle the TODO marker on plain Enter or Shift-Enter", () => {
    expect(decideEditorKey(input({ key: "Enter" })))
      .toEqual({ type: "split", cursor: 0 });
    expect(decideEditorKey(input({ key: "Enter", metaKey: true, shiftKey: true })))
      .toEqual({ type: "none" });
  });

  it("suppresses the TODO cycle when read-only", () => {
    expect(decideEditorKey(input({ key: "Enter", metaKey: true, readOnly: true })))
      .toEqual({ type: "none" });
  });

  it("indents / outdents on Tab", () => {
    expect(decideEditorKey(input({ key: "Tab" }))).toEqual({ type: "indent" });
    expect(decideEditorKey(input({ key: "Tab", shiftKey: true })))
      .toEqual({ type: "outdent" });
  });

  it("leaves every Option/Alt+Arrow variant to the platform", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(decideEditorKey(input({ key, altKey: true })))
        .toEqual({ type: "none" });
      expect(decideEditorKey(input({
        key, altKey: true, shiftKey: true, metaKey: true,
      }))).toEqual({ type: "none" });
    }
  });

  it("backspaces into the previous block at the start", () => {
    expect(decideEditorKey(input({ key: "Backspace", selStart: 0, selEnd: 0 })))
      .toEqual({ type: "backspace-at-start" });
    // Not at the start: browser default.
    expect(decideEditorKey(input({ key: "Backspace", selStart: 1, selEnd: 1 })))
      .toEqual({ type: "none" });
  });
});

describe("decideEditorKey ctrl-cmd selection (pkm-am54)", () => {
  it("selects to the block start on Ctrl+Cmd+ArrowLeft", () => {
    expect(decideEditorKey(input({
      key: "ArrowLeft", ctrlKey: true, metaKey: true, draft: "hello",
      selStart: 3, selEnd: 3,
    }))).toEqual({ type: "select-to-block-edge", edge: "start" });
  });

  it("selects to the block end on Ctrl+Cmd+ArrowRight", () => {
    expect(decideEditorKey(input({
      key: "ArrowRight", ctrlKey: true, metaKey: true, draft: "hello",
      selStart: 3, selEnd: 3,
    }))).toEqual({ type: "select-to-block-edge", edge: "end" });
  });

  it("selects the whole block on Ctrl+Cmd+ArrowUp/Down from anywhere", () => {
    for (const key of ["ArrowUp", "ArrowDown"]) {
      // collapsed caret mid-block
      expect(decideEditorKey(input({
        key, ctrlKey: true, metaKey: true, draft: "hello",
        selStart: 3, selEnd: 3,
      }))).toEqual({ type: "select-whole-block" });
      // an existing text selection is replaced by the block selection
      expect(decideEditorKey(input({
        key, ctrlKey: true, metaKey: true, draft: "hello",
        selStart: 0, selEnd: 3,
      }))).toEqual({ type: "select-whole-block" });
    }
  });

  it("still selects while read-only (selection/copy are read-only-safe)", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", ctrlKey: true, metaKey: true, readOnly: true,
    }))).toEqual({ type: "select-whole-block" });
    expect(decideEditorKey(input({
      key: "ArrowLeft", ctrlKey: true, metaKey: true, readOnly: true,
      draft: "x", selStart: 1, selEnd: 1,
    }))).toEqual({ type: "select-to-block-edge", edge: "start" });
  });

  it("wins over an open autocomplete popup", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", ctrlKey: true, metaKey: true, acRowsLength: 3,
      acSelected: 1,
    }))).toEqual({ type: "select-whole-block" });
  });

  it("ignores the chords when Shift or Alt is also held", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
      for (const extra of [{ shiftKey: true }, { altKey: true }]) {
        expect(decideEditorKey(input({
          key, ctrlKey: true, metaKey: true, draft: "x",
          selStart: 1, selEnd: 1, ...extra,
        }))).toEqual({ type: "none" });
      }
    }
  });
});

describe("decideEditorKey boundary arrows", () => {
  it("moves focus up when the caret is on the first line", () => {
    expect(decideEditorKey(input({ key: "ArrowUp", draft: "a\nb", selStart: 1 })))
      .toEqual({ type: "arrow", dir: "up" });
  });

  it("stays in the block on ArrowUp when a wrapped display line is measured above the caret", () => {
    // No logical newline before the caret (so the old heuristic alone would
    // jump), but the shell measured the caret as NOT on the first display
    // line of a soft-wrapped block: native caret-up should win instead.
    expect(decideEditorKey(input({
      key: "ArrowUp", draft: "one long line with no newlines at all", selStart: 20,
      selEnd: 20, caretOnFirstDisplayLine: false,
    }))).toEqual({ type: "none" });
  });

  it("still jumps on ArrowUp when caretOnFirstDisplayLine is true or unmeasured", () => {
    expect(decideEditorKey(input({
      key: "ArrowUp", draft: "wraps but caret is on the first display line",
      selStart: 5, selEnd: 5, caretOnFirstDisplayLine: true,
    }))).toEqual({ type: "arrow", dir: "up" });
    // undefined = unmeasured (jsdom, or measurement bailed) -> old behaviour.
    expect(decideEditorKey(input({
      key: "ArrowUp", draft: "no newline here", selStart: 5, selEnd: 5,
    }))).toEqual({ type: "arrow", dir: "up" });
  });

  it("stays in the block on ArrowDown when a wrapped display line is measured below the selection end", () => {
    expect(decideEditorKey(input({
      key: "ArrowDown", draft: "one long line with no newlines at all", selStart: 20,
      selEnd: 20, caretOnLastDisplayLine: false,
    }))).toEqual({ type: "none" });
  });

  it("still jumps on ArrowDown when caretOnLastDisplayLine is true or unmeasured", () => {
    expect(decideEditorKey(input({
      key: "ArrowDown", draft: "wraps but selEnd is on the last display line",
      selStart: 5, selEnd: 5, caretOnLastDisplayLine: true,
    }))).toEqual({ type: "arrow", dir: "down" });
    expect(decideEditorKey(input({
      key: "ArrowDown", draft: "no newline here", selStart: 5, selEnd: 5,
    }))).toEqual({ type: "arrow", dir: "down" });
  });

  it("does not move up from a lower line", () => {
    expect(decideEditorKey(input({ key: "ArrowUp", draft: "a\nb", selStart: 3, selEnd: 3 })))
      .toEqual({ type: "none" });
  });

  it("moves focus down when the caret is on the last line", () => {
    expect(decideEditorKey(input({
      key: "ArrowDown", draft: "a\nb", selStart: 2, selEnd: 2,
    }))).toEqual({ type: "arrow", dir: "down" });
  });

  it("moves left only from the very start", () => {
    expect(decideEditorKey(input({ key: "ArrowLeft", selStart: 0, selEnd: 0 })))
      .toEqual({ type: "arrow", dir: "left" });
    expect(decideEditorKey(input({ key: "ArrowLeft", selStart: 1, selEnd: 1 })))
      .toEqual({ type: "none" });
  });

  it("moves right only from the very end", () => {
    expect(decideEditorKey(input({
      key: "ArrowRight", draft: "abc", selStart: 3, selEnd: 3,
    }))).toEqual({ type: "arrow", dir: "right" });
    expect(decideEditorKey(input({
      key: "ArrowRight", draft: "abc", selStart: 1, selEnd: 1,
    }))).toEqual({ type: "none" });
  });

  it("leaves Meta/Ctrl/Alt arrows at block boundaries to the platform", () => {
    // Cmd-Left at the start, Cmd-Up on the first line, etc. are native text
    // navigation (caret to line/document boundary) and must not fall through
    // to block navigation, which would preventDefault the native behaviour.
    expect(decideEditorKey(input({
      key: "ArrowLeft", metaKey: true, selStart: 0, selEnd: 0,
    }))).toEqual({ type: "none" });
    expect(decideEditorKey(input({
      key: "ArrowLeft", altKey: true, selStart: 0, selEnd: 0,
    }))).toEqual({ type: "none" });
    expect(decideEditorKey(input({
      key: "ArrowUp", metaKey: true, draft: "a", selStart: 1, selEnd: 1,
    }))).toEqual({ type: "none" });
    expect(decideEditorKey(input({
      key: "ArrowDown", ctrlKey: true, draft: "a", selStart: 1, selEnd: 1,
    }))).toEqual({ type: "none" });
    expect(decideEditorKey(input({
      key: "ArrowRight", metaKey: true, draft: "a", selStart: 1, selEnd: 1,
    }))).toEqual({ type: "none" });
  });

  it("keeps block-selection start on plain Shift only (no Meta/Ctrl)", () => {
    // Ctrl-Shift-Up is a native select-to-paragraph-start binding; it must
    // not hijack into a block selection.
    expect(decideEditorKey(input({
      key: "ArrowUp", shiftKey: true, ctrlKey: true, draft: "x",
      selStart: 0, selEnd: 0,
    }))).toEqual({ type: "none" });
  });
});

describe("decideEditorKey browser default", () => {
  it("returns none for an ordinary character", () => {
    expect(decideEditorKey(input({ key: "a", draft: "a", selStart: 1, selEnd: 1 })))
      .toEqual({ type: "none" });
  });
});

describe("decideEditorKey undo/redo (pkm-7q14)", () => {
  it("Cmd-Z is undo, Shift-Cmd-Z is redo (Ctrl variants for non-Mac)", () => {
    expect(decideEditorKey(input({ key: "z", metaKey: true }))).toEqual({ type: "undo" });
    expect(decideEditorKey(input({ key: "z", ctrlKey: true }))).toEqual({ type: "undo" });
    expect(decideEditorKey(input({ key: "Z", metaKey: true, shiftKey: true }))).toEqual({ type: "redo" });
    expect(decideEditorKey(input({ key: "Z", ctrlKey: true, shiftKey: true }))).toEqual({ type: "redo" });
  });

  it("Alt-Z and plain z are not undo", () => {
    expect(decideEditorKey(input({ key: "z", metaKey: true, altKey: true }))).toEqual({ type: "none" });
    expect(decideEditorKey(input({ key: "z" }))).toEqual({ type: "none" });
  });

  it("undo/redo are read-only-gated", () => {
    expect(decideEditorKey(input({ key: "z", metaKey: true, readOnly: true }))).toEqual({ type: "none" });
  });
});

describe("decideEditorKey meta-wrap shortcuts (Cmd-K/B/I)", () => {
  it("Cmd-B toggles bold as a key-edit", () => {
    expect(decideEditorKey(input({
      key: "b", metaKey: true, draft: "make bold now", selStart: 5, selEnd: 9,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "make **bold** now", selStart: 7, selEnd: 11 },
    });
  });

  it("Cmd-I toggles italic as a key-edit", () => {
    expect(decideEditorKey(input({
      key: "i", metaKey: true, draft: "word", selStart: 0, selEnd: 4,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "__word__", selStart: 2, selEnd: 6 },
    });
  });

  it("Cmd-K still wraps a link", () => {
    expect(decideEditorKey(input({
      key: "k", metaKey: true, draft: "text", selStart: 0, selEnd: 4,
    }))).toEqual({
      type: "key-edit",
      edit: { text: "[text]()", selStart: 7, selEnd: 7 },
    });
  });

  it("ignores the chord when Ctrl, Alt or Shift is also held", () => {
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
      expect(decideEditorKey(input({
        key: "b", metaKey: true, draft: "x", selStart: 0, selEnd: 1, ...extra,
      }))).toEqual({ type: "none" });
      // Cmd-Shift-K no longer link-wraps (reserved for future chords)
      expect(decideEditorKey(input({
        key: "k", metaKey: true, draft: "x", selStart: 0, selEnd: 1, ...extra,
      }))).toEqual({ type: "none" });
    }
  });

  it("does nothing without Meta (Ctrl-B stays an emacs textarea binding)", () => {
    expect(decideEditorKey(input({
      key: "b", ctrlKey: true, draft: "x", selStart: 0, selEnd: 1,
    }))).toEqual({ type: "none" });
  });

  it("is read-only gated", () => {
    expect(decideEditorKey(input({
      key: "b", metaKey: true, readOnly: true, draft: "x", selStart: 0, selEnd: 1,
    }))).toEqual({ type: "none" });
  });
});
