---
# pkm-2867
title: Plain ArrowUp/Down in a wrapped block jumps blocks instead of moving a display line
status: completed
type: bug
priority: low
created_at: 2026-07-22T18:29:27Z
updated_at: 2026-07-22T19:08:49Z
---

keyboardPolicy decides boundary arrows from logical newlines only, so in a block that wraps onto several display lines, plain ArrowUp/Down from any display line jumps focus to the neighbouring block instead of moving the caret one visual line. Fixing needs display-line awareness in the shell (e.g. compare caret rect before/after letting the native move happen, or measure with getClientRects) since the functional core cannot see wrapping. Found during pkm-am54; pre-existing, unchanged there.

## Plan

- [x] TDD: core tests for display-line-gated boundary arrows (new inputs on EditorKeyInput)
- [x] Core: require first/last display line for plain ArrowUp/Down boundary jump
- [x] Shell: mirror-div caret display-line measurement (imperative, lazy — only for unmodified ArrowUp/Down)
- [x] E2E: wrapped block — plain ArrowUp/Down from inner display line stays in block; from edge display line jumps
- [x] pnpm verify green

## Summary of Changes

Root cause: `decideEditorKey` in `web/src/outline/keyboardPolicy.ts` decided
plain ArrowUp/Down boundary jumps purely from LOGICAL newlines
(`draft.slice(0, pos).includes("\n")` / same for the tail after `selEnd`).
A block with no `\n` at all but long enough to soft-wrap onto several
DISPLAY lines therefore jumped focus to the neighbouring block from every
visual line, instead of letting the caret move up/down within the block
first. The functional core has no DOM access and can't see wrapping, so the
fix needed the shell to measure it and pass the result in.

Design (matches the brief, no material deviations):

- `EditorKeyInput` gained two optional fields, `caretOnFirstDisplayLine?` and
  `caretOnLastDisplayLine?`. The boundary-arrow checks became `... &&
  caretOnFirstDisplayLine !== false` (ArrowUp) / `... && caretOnLastDisplayLine
  !== false` (ArrowDown) — `undefined` (unmeasured, e.g. jsdom) preserves the
  old newline-only behaviour exactly, so every existing unit test kept
  passing unmodified.
- New shell file `web/src/outline/caretDisplayLine.ts`
  (`measureCaretDisplayLine(el, pos)`) does the real DOM measurement:
  - Fast path: reads the textarea's own `clientHeight` vs `line-height`
    (no mirror needed) — if the content fits one line, returns
    `{ first: true, last: true }` immediately. This also doubles as the
    "unmeasurable" bail-out: in jsdom `clientHeight` is always 0, so
    `contentHeight <= 0` returns `null` (no layout engine), which is exactly
    the graceful "fall back to old behaviour" case core the relies on.
  - Two more shortcuts once wrapping is confirmed (contentHeight > 1 line):
    `pos <= 0` is always the first display line, `pos >= text.length` is
    always the last — both skip building a mirror.
  - Otherwise: builds an offscreen mirror `<div>` copying every
    computed style that affects wrapping (box-sizing, width, padding,
    border widths, font shorthand parts, letter-spacing, line-height,
    tab-size, word-break, overflow-wrap; whitespace forced to `pre-wrap`),
    inserts `text.slice(0,pos)` as a text node, a zero-width-space marker
    `<span>`, then the remaining text, appends to `document.body`, and
    compares `marker.offsetTop` against 0 and `mirror.scrollHeight -
    (offsetTop + offsetHeight)` against half a line-height to decide
    first/last. The mirror is always removed in a `finally`.
  - One deliberate simplification vs. the brief: `measureCaretDisplayLine`
    takes a single `pos` and returns both `{first, last}` for that one
    position, rather than the shell needing separate "first" and "last"
    calls with different internal logic. The shell wiring only ever needs
    one of the two bits per keypress (ArrowUp wants "first" at `selStart`,
    ArrowDown wants "last" at `selEnd`), so `EditableBlockTree.tsx` calls it
    at most once per keydown — never twice, keeping the mirror-DOM cost to
    one build per arrow press instead of two.
- Shell wiring in `web/src/components/EditableBlockTree.tsx`'s `onKeyDown`:
  measurement is gated on `!metaKey && !ctrlKey && !altKey && !shiftKey` and
  the specific key (`ArrowUp` measures at `selectionStart`, `ArrowDown` at
  `selectionEnd`) so it never runs for any other key or for the
  Shift/Meta/Ctrl arrow chords (block-selection-start, subtree-move,
  Ctrl-Cmd selection) — those are explicitly out of scope and untouched.

Files changed:
- `web/src/outline/keyboardPolicy.ts` — new optional fields + gated checks
- `web/src/outline/keyboardPolicy.test.ts` — 4 new unit tests (up/down ×
  measured-false / true-or-undefined)
- `web/src/outline/caretDisplayLine.ts` — new Imperative Shell module
- `web/src/components/EditableBlockTree.tsx` — wiring in `onKeyDown`
- `web/e2e/wrapped-arrow.spec.ts` — new spec: wrapped block stays put on
  ArrowUp/Down from a middle display line and jumps only once the caret
  reaches the first/last display line (sanity-checked by temporarily
  reverting the core fix and confirming this test fails, then restoring
  it and confirming it passes again); plus a fast-path regression test
  (short non-wrapping block still jumps on the very first ArrowUp)

Verify (from `web/`, `E2E_PORT=8976` since 8975's default clashed with a
concurrent session, 8974 never touched):

```
$ pnpm typecheck && pnpm lint && pnpm check:fcis && pnpm test:coverage && vite build && node tooling/runPlaywright.mjs
check:fcis: 115 runtime modules, no boundary violations.
 Test Files  96 passed (96)
      Tests  1405 passed (1405)
All files          |   97.48 |    92.32 |   95.61 |   97.48 |
bundle budget report: OK
precache budget report: OK
Running 25 tests using 1 worker
  25 passed (19.0s)
```

Coverage thresholds (statements 95 / branches 91 / functions 89 / lines 95)
are met in aggregate even though `caretDisplayLine.ts` itself scores low
under jsdom (no layout engine, so most of its branches are unreachable in
unit tests) — same convention already used for other DOM-heavy shell files
in this coverage report (e.g. `PageView.tsx` at 89.75%, `roamTable.tsx` at
54.54% branches): no blanket threshold changes or explicit exclusions were
needed since the repo-wide numbers stayed comfortably above the gate.
