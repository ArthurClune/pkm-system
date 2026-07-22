---
# pkm-am54
title: 'Ctrl-Cmd arrow selection: select to block edge / whole-block selection'
status: completed
type: bug
priority: normal
created_at: 2026-07-22T18:17:46Z
updated_at: 2026-07-22T18:28:11Z
---

Ctrl-Cmd-Left/Right should select from the caret to the block's start/end (logical block, not display line) and then stop. Ctrl-Cmd-Up/Down: first press selects the whole current block as a block selection; further presses extend the selection block-by-block up/down. Currently keyboardPolicy's trailing arrow rules ignore modifiers, so Ctrl-Cmd-Up/Down steals focus to the neighbouring block (killing native selection), and on wrapped blocks native display-line selection is the only thing that happens — no quick way to select a whole wrapped block.

## Checklist

- [x] Failing unit tests for keyboardPolicy ctrl-cmd decisions + modifier fall-through regressions
- [x] Policy: ctrl-cmd-left/right -> select-to-block-edge; ctrl-cmd-up/down -> select-whole-block; gate trailing arrow rules on no modifiers
- [x] Shell: execute new decisions (setSelectionRange / onSelectBlock); tree container extends selection on ctrl-cmd-up/down
- [x] useOutline: onSelectBlock handler (flush, blur, single-block selection)
- [x] Verify in browser + full web verify
- [x] Commit, merge --no-ff, push

## Summary of Changes

Root cause: keyboardPolicy's trailing boundary-arrow rules ignored modifiers, so any Ctrl/Cmd/Alt+Arrow reaching them was treated as plain block navigation — preventDefault killed the native selection and focus jumped to a neighbouring block. There was no app-level Ctrl-Cmd handling at all, so wrapped blocks only ever got native display-line selection.

- keyboardPolicy: new decisions `select-to-block-edge` (Ctrl-Cmd-Left/Right) and `select-whole-block` (Ctrl-Cmd-Up/Down), placed before the autocomplete claim and read-only-safe; boundary-arrow rules now fire only without Meta/Ctrl/Alt; block-selection start is plain-Shift only (Ctrl-Shift-Up stays native).
- EditableBlockTree: executes the new decisions (setSelectionRange to the block edge; onSelectBlock), and the tree container extends an active selection on Ctrl-Cmd-Up/Down.
- useOutline: onSelectBlock — flush draft, blur, selection {anchor: uid, head: uid}.
- Tests: policy/component/hook units + e2e (edit.spec.ts pkm-am54). Full `pnpm verify` green; behaviour confirmed in a live browser session.

Noted for a possible follow-up: plain ArrowUp/Down in a wrapped (visually multi-line) block always jumps to the neighbouring block — the policy cannot see display lines. Pre-existing, unchanged here.
