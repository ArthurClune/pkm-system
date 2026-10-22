---
# pkm-a5bq
title: A placed caret can split a surrogate pair
status: completed
type: bug
priority: normal
created_at: 2026-10-22T08:34:04Z
updated_at: 2026-10-22T08:36:02Z
parent: pkm-a1xk
---

validateOutlineFocus clamped a stored caret to the text but kept an in-range offset as given, so a caret kept across a remote edit (adoptShared) or restored by undo (applyFocus) could land between an emoji's surrogate halves; text typed there leaves both halves lone, saved as U+FFFD. Found reading the pkm-mtxu property; Arthur (2026-10-22): do the defensive fix.

## Checklist
- [x] Failing unit test (a😀b, cursor 2 -> 1) and property expecting a snapped caret
- [x] validateOutlineFocus snaps the clamped caret with snapCaret
- [x] frontend-editor.md rule row names the placed caret
- [x] pnpm verify

## Summary of Changes

validateOutlineFocus now snaps the clamped caret with snapCaret, so a caret the editor places (remote adopt, undo focus restore) never splits a surrogate pair. Unit test for a😀b at cursor 2; the validateOutlineFocus property now expects a snapped caret for its mid-pair draws (fails with the snap removed). frontend-editor.md's snapCaret rule names the placed caret.
