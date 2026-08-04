---
# pkm-jgtn
title: 'Shift-selection keyboard: line-wise Shift-Cmd-Left/Right; Shift-Up/Down with text selected starts block selection'
status: in-progress
type: bug
priority: normal
created_at: 2026-08-04T08:54:35Z
updated_at: 2026-08-04T09:01:24Z
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
- [ ] Commit, merge --no-ff
