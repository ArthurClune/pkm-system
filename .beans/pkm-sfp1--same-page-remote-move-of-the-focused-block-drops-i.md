---
# pkm-sfp1
title: Same-page remote move of the focused block drops its pending draft
status: completed
type: bug
priority: normal
created_at: 2026-09-29T14:15:15Z
updated_at: 2026-09-29T15:37:08Z
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

- [x] Failing test reproducing the loss (red for the stated reason)
- [x] Remounted textarea shows and keeps the pending draft
- [x] Row in docs/troubleshooting.md

## Summary of Changes

- `OutlineHandlers` gains `pendingDraft(uid)` (the pending draft's text plus the recorded selection, or null) and `onInputUnmount(uid, selStart, selEnd)`; new type `ResumedDraft` in `outline/handlers.ts`. `useOutline` answers from `pendingRef` and a `draftSelectionRef` that every flush (`takePendingTextOps`) clears, and records a selection only while that uid's draft is pending.
- `useBlockDraft` takes `resume()` and `onUnmount()`. A resumed draft starts from the pending text, dirty (so the tree's text does not replace it and no `onDraftStart` fires, keeping the base). Its selection is read at mount, not at render, because the replaced textarea reports its selection (layout cleanup) in the same commit, after the new one rendered. Falls back to the end of the draft when none was recorded.
- Deviation from the plan: the caret goes back where the user left it (the ruling given at dispatch) instead of to the end of the draft.
- Tests: eight in `EditablePage.test.tsx` (move keeps draft + base; caret kept from a typed selection; caret kept after a caret-only move; resumed draft goes clean then adopts remote text; move+edit batch keeps draft and base hash of "first"; parent reparent remounts child with its draft; held draft survives and flushes on blur; Cmd+Z pin). Seven were red before the fix at the first value assertion (textarea showed the tree's text); the Cmd+Z pin passed pre-fix, as the plan predicted. Three `BlockInput` pins (resume shows draft, restores selection, stays dirty, no onDraftStart; end fallback; unmount reports selection).
- E2E `web/e2e/remote-move-draft.spec.ts`: red pre-fix at `toHaveValue` (showed "first": Chromium delivered no blur), green on the fix, and also asserts the caret at offset 2 after the remount.
- Docs: note in frontend-editor.md § Drafts and commit points; Editor row in troubleshooting.md.
