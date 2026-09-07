---
# pkm-i4ex
title: Raise the multi-block delete confirm threshold and correct its undo wording
status: completed
type: bug
priority: normal
created_at: 2026-09-07T12:36:22Z
updated_at: 2026-09-07T12:37:52Z
---

The Backspace/Delete-on-selection confirm says 'This cannot be undone', but the delete is an ordinary undoable history entry (Cmd-Z, per-tab, until reload). Keep the confirm but raise LARGE_DELETE_THRESHOLD and make the message truthful.

- [x] Unit tests updated for new threshold and message
- [x] blockSelection.ts threshold raised
- [x] useOutline.ts message corrected
- [x] docs/keyboard.md updated
- [x] pnpm test:unit + typecheck green

## Summary of Changes

- `LARGE_DELETE_THRESHOLD` raised from 5 to 20 in `web/src/outline/blockSelection.ts`, with a comment that the prompt guards against surprise, not data loss.
- Confirm text in `useOutline.ts` changed from "This cannot be undone." to "Cmd+Z undoes this until you reload." — the delete is an ordinary history entry (per-tab global, survives page navigation, lost on reload).
- Unit tests in `blockSelection.test.ts` and `useOutline.selection.test.tsx` moved to the 20/21 boundary and assert the old wording is gone.
- `docs/keyboard.md` selection table updated.
