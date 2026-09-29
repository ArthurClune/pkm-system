---
# pkm-sfp1
title: Same-page remote move of the focused block drops its pending draft
status: todo
type: bug
created_at: 2026-09-29T14:15:15Z
updated_at: 2026-09-29T14:15:15Z
parent: pkm-a4t2
---

Found by the adversarial review of pkm-impk. Predates that branch (present on main).

## Symptom

The user is typing in a block. Another device reparents or moves that block within the same page. The user keeps typing within the debounce window. The text typed before the move is lost: only the text typed after it is sent.

## Cause

A same-page remote reparent/move remounts the focused block's textarea, as a local same-page move does. The new `BlockInput`/`useBlockDraft` starts clean and shows the tree's text, not the draft. `pendingRef` in `useOutline` still holds the draft, but the next keystroke is typed over the tree text, and `captureDraft` (same uid) replaces the draft's text with it.

## Reproduction

In `web/src/views/EditablePage.test.tsx` style, with blocks u1 "first", u2 "second" on page "Page":

1. Fake timers; focus u1; `fireEvent.change` to "typed".
2. Emit a remote batch `{ op: "move", uid: "u1", parent_uid: "u2", order_idx: 0, page_title: "Page" }`.
3. The remounted textarea shows "first", not "typed".
4. Type "first!" and advance 500 ms: only "first!" is sent; "typed" is gone.

## Suggested fix

When `BlockInput` mounts for the uid that `pendingRef` holds, seed its draft from the pending text and mark it dirty (for example, expose the pending draft to the tree, or have `useBlockDraft` take an initial dirty draft).

## Checklist

- [ ] Failing test reproducing the loss (red for the stated reason)
- [ ] Remounted textarea shows and keeps the pending draft
- [ ] Row in docs/troubleshooting.md
