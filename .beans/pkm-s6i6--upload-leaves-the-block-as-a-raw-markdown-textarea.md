---
# pkm-s6i6
title: /upload leaves the block as a raw-markdown textarea instead of rendering the image
status: completed
type: bug
priority: normal
created_at: 2026-08-25T19:24:58Z
updated_at: 2026-08-25T19:30:09Z
---

After /upload completes, onFiles (web/src/outline/useOutline.ts) unconditionally re-focuses the target block. On the /upload path the native file dialog already blurred the block (focus is null, the block renders read-only during the upload), so the forced re-focus swaps the line back to a raw-markdown textarea and the image only appears once the user moves the cursor to another line.

Fix: restore focus only when the target block still owns focus at upload completion (the paste/drag-drop case, where the caret must move past the spliced markdown). If focus is null or elsewhere (the /upload dialog path, or the user moved on during a slow upload), leave focus untouched so the block renders the image immediately.

- [x] Failing test: /upload path (focus null when onFiles fires) — focus stays null after the splice
- [x] Test: paste/drop path (block focused) — focus restored with cursor after the inserted markdown
- [x] Test: focus moved to another block during a slow upload — left alone
- [x] Implement the conditional in onFiles
- [x] pnpm verify green

## Summary of Changes

`onFiles` in `web/src/outline/useOutline.ts` now restores focus only when the target block still owns it at upload completion (`focusRef.current?.uid === uid`) — the paste/drag-drop case, where the caret must move past the spliced markdown. On the /upload dialog path the native picker already blurred the block, so `focus: null` (run()'s leave-as-is) lets the block render the uploaded image immediately instead of re-opening a raw-markdown textarea. Three tests added in `useOutline.upload.test.tsx` (dialog path, paste/drop path, focus moved elsewhere during a slow upload — deterministic via `defer()`); the two new focus assertions failed before the fix. Full `pnpm verify` green (typecheck, unit 2303 passed, 54 e2e passed).
