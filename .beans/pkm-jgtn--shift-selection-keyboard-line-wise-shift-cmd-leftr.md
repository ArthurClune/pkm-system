---
# pkm-jgtn
title: 'Shift-selection keyboard: line-wise Shift-Cmd-Left/Right; Shift-Up/Down with text selected starts block selection'
status: completed
type: bug
priority: normal
created_at: 2026-08-04T08:54:35Z
updated_at: 2026-08-04T09:15:56Z
---

Two related editor selection issues (multi-line blocks).

1) Shift-Cmd-Left selects to start of line, but pressing it again does nothing. It should extend the selection line-by-line upward within the block (mirror for Shift-Cmd-Right, downward). Follows the pkm-am54 precedent: logical lines, not display lines.

2) Shift-Up with a text selection active loses the selection and jumps focus to the block above (keyboardPolicy's start-block-selection branch requires a collapsed caret, and the boundary-arrow rules exclude Meta/Ctrl/Alt but not Shift, so the shifted arrow at the top line falls into 'arrow up'). Expected: Shift-Up with text selected should start a block selection covering the current block plus the block above (same as the collapsed-caret edge case already does, and as Ctrl-Cmd-Up already handles). Mirror for Shift-Down.

## Checklist

- [x] Failing unit tests: shift-cmd-left/right line-wise decisions; shift+arrow with a non-collapsed selection at the edge starts block selection; shift never falls into boundary arrows
- [x] Policy: select-range decision (logical-line-wise Shift-Cmd-Left/Right); drop caretOnly from start-block-selection; exclude Shift from boundary arrows
- [x] Shell (BlockInput): execute select-range via setSelectionRange
- [x] docs/keyboard.md + docs/architecture/frontend.md if needed
- [x] pnpm verify green
- [x] Commit, merge --no-ff

## Summary of Changes

Root causes (both in keyboardPolicy.ts, the pure keydown core):

1. Shift-Cmd-Left/Right had no app handling at all — native macOS selects to the display-line boundary and dead-ends on the second press. Added a `select-range` decision: line-wise selection over LOGICAL lines (pkm-am54 precedent) — first press to the line start/end, each further press adds one whole line, stopping at the block edge. Read-only-safe, so it sits before the read-only cutoff; BlockInput executes it with setSelectionRange (preventDefault).

2. `start-block-selection` required a collapsed caret (a deliberate compatibility choice when the policy was extracted — there was even a unit test locking it in), and the boundary-arrow rules excluded Meta/Ctrl/Alt but NOT Shift. So Shift-Up with a text selection whose start sat on the first line fell into `{type:'arrow'}`: focus jumped a block up and the selection died. Now the edge is measured at the end that would move (selStart going up / selEnd going down) regardless of collapsed-ness, so a text selection escalates to a block selection once it can't grow within the block; and Shift is excluded from boundary-arrow navigation entirely (Shift-Left at offset 0 / Shift-Right at the end stay native no-ops instead of stealing focus).

Docs: keyboard.md (drives the in-app Help) and frontend.md's keyboard-surface enumeration updated; stale Ctrl+Alt heading chord corrected to Cmd+Alt (pkm-bt9h).

Verified: pnpm verify green on the branch and again on merged main (1952 unit, 49 e2e). Merged --no-ff at 179851c. Not deployed to prod.

Worth a live keypress check (jsdom/e2e can't prove macOS chord routing end-to-end): Shift-Cmd-Left/Right in a multi-line block, and Shift-Up with text selected.
