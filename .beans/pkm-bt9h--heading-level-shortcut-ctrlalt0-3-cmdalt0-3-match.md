---
# pkm-bt9h
title: Heading-level shortcut Ctrl+Alt+0-3 -> Cmd+Alt+0-3 (match Google Docs)
status: completed
type: bug
priority: normal
created_at: 2026-07-27T08:47:50Z
updated_at: 2026-07-27T08:47:59Z
---

Change the heading-level keyboard shortcut from Ctrl+Alt+<digit> to
Cmd+Alt+<digit> (Alt/Option + Meta/Cmd), matching Google Docs (⌥⌘1/2/3 set
heading level, ⌥⌘0 back to plain text).

## Todo

- [x] Update `web/src/outline/keyboardPolicy.ts` set-heading branch to require
      `i.metaKey && i.altKey && !i.ctrlKey && !i.shiftKey`, keep matching on
      `i.code`, and update/add the comment explaining why `code` (not `key`)
      is load-bearing on macOS.
- [x] Verify no conflict with other Meta chords in the policy file (the
      wrap-edit branch requires `!altKey`, so no overlap).
- [x] Update `web/src/outline/keyboardPolicy.test.ts`: heading chord tests now
      use Meta+Alt for digits 0-3, plus an explicit regression test that the
      old Ctrl+Alt chord returns `none`.
- [x] Update `docs/keyboard.md` shortcut table rows (Ctrl+Alt+1/2/3 ->
      Cmd+Alt+1/2/3, Ctrl+Alt+0 -> Cmd+Alt+0), matching the file's existing
      Cmd notation.
- [x] Search `web/e2e/` and `web/src/` for other uses of the old chord and
      update them (`EditableBlockTree.test.tsx`, `EditablePage.test.tsx`).
- [x] Run `cd web && pnpm verify` (typecheck, unit coverage, Playwright e2e).

## Summary of Changes

- `web/src/outline/keyboardPolicy.ts`: the set-heading branch now requires
  `i.metaKey && i.altKey && !i.ctrlKey && !i.shiftKey` instead of
  `i.ctrlKey && i.altKey`. Matching stays on `i.code` (Digit0-3, falling back
  to `i.key` when `code` is unavailable), with a new comment explaining that
  macOS mutates `key` for Option+digit (e.g. Option-1 -> "¡") so `code` is
  load-bearing. Verified no other Meta+Alt chord exists in the policy file
  (the Meta-only wrap-edit branch explicitly requires `!altKey`).
- `web/src/outline/keyboardPolicy.test.ts`: heading-chord tests updated to
  Cmd+Alt+Digit; added a regression test asserting the old Ctrl+Alt+Digit
  chord now falls through to `{ type: "none" }`, plus a test that Ctrl held
  alongside Cmd+Alt also falls through. The read-only suppression test's
  heading-digit case was switched to the new chord.
- `web/src/components/EditableBlockTree.test.tsx`: renamed and updated the
  heading-shortcut tests to fire `metaKey` instead of `ctrlKey`, and added an
  explicit test that the old Ctrl+Alt chord no longer calls `onSetHeading`.
- `web/src/views/EditablePage.test.tsx`: updated the two heading-shortcut
  tests (initial title-rename flow and focused-typography test) to fire
  `metaKey` instead of `ctrlKey`.
- `docs/keyboard.md`: shortcut table rows changed to `Cmd+Alt+1/2/3` /
  `Cmd+Alt+0`, matching the file's existing Cmd-first notation.
- No e2e specs exercised this chord directly (`web/e2e/help.spec.ts`
  references `heading` only for page-structure roles, unrelated to this
  shortcut), so no e2e changes were needed.
