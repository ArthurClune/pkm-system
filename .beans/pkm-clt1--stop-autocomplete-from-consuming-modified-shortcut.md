---
# pkm-clt1
title: Stop autocomplete from consuming modified shortcuts
status: completed
type: bug
created_at: 2026-08-01T13:21:07Z
updated_at: 2026-08-01T13:21:07Z
parent: pkm-6phf
---

Epic pkm-6phf medium finding 10.

**References:** web/src/outline/keyboardPolicy.ts:110-121; web/src/components/Composer.tsx:48-54

The editor policy says autocomplete owns unmodified arrows/Enter/Tab/Escape, but Cmd/Ctrl/Shift variants are not rejected. Modified keys can navigate or pick autocomplete instead of performing native selection/navigation or editor commands. Composer duplicates the same modifier-insensitive behavior.

**Direction:** Explicitly validate the allowed modifier set and reuse one keyboard policy in both editors.

- [x] Add modifier-combination tests
- [x] Enforce unmodified autocomplete commands through a shared policy

## Summary of Changes

Added `autocompleteKeyAction` to `web/src/outline/keyboardPolicy.ts` (Functional Core): a small pure function that returns `"move-up" | "move-down" | "pick" | "close" | null` for a keydown, rejecting the action (`null`) whenever any of Cmd/Ctrl/Shift/Alt is held. `decideEditorKey`'s autocomplete block now calls this instead of checking `i.key` alone, so modified Arrow/Enter/Tab/Escape fall through to the same decision they'd get with the popup closed (native selection, todo-cycle, indent/outdent, split, blur, etc.) instead of being swallowed as `ac-move`/`ac-pick`/`ac-close`.

`Composer.tsx`'s `onKeyDown` no longer re-implements its own modifier-insensitive arrow/Enter/Tab/Escape checks — it calls the same `autocompleteKeyAction` and only acts (and calls `preventDefault`) when it returns non-null, so a modified key leaves the textarea's native behaviour untouched instead of navigating/picking/closing the popup.

Tests added:
- `keyboardPolicy.test.ts`: a table-driven case covering Cmd/Ctrl/Shift/Alt × ArrowUp/ArrowDown/Enter/Tab/Escape with the popup open, asserting each falls through to the exact same decision as with the popup closed (never `ac-move`/`ac-pick`/`ac-close`); plus direct unit tests for `autocompleteKeyAction` (unmodified claims, modified rejects, unrelated keys ignored).
- `Composer.test.tsx`: the same modifier × key cross-product against the rendered Composer, asserting the draft value and the popup's selected row are unchanged after all 20 modified keydowns.

Files changed: `web/src/outline/keyboardPolicy.ts`, `web/src/outline/keyboardPolicy.test.ts`, `web/src/components/Composer.tsx`, `web/src/components/Composer.test.tsx`.
