---
# pkm-gbsb
title: /upload file picker silently drops the chosen file when the block blurs
status: in-progress
type: bug
priority: high
created_at: 2026-07-19T15:10:31Z
updated_at: 2026-07-19T15:10:31Z
---

## Symptom

/upload on a block opens the file picker, but the chosen file never uploads: no POST /api/assets is made, nothing is spliced into the block, and no error is shown. Observed in prod 2026-07-19 ~15:58 BST uploading Logistic-curve.svg.png to [[Softmax Function]] while fully online (ops traffic flowing on the same connection).

## Root cause

The hidden `<input type="file">` lives inside `BlockInput` (web/src/components/EditableBlockTree.tsx:622), and `BlockInput` is mounted only for the focused block (line 285, `{focused ? <BlockInput .../> : ...}`).

Chain:
1. `/upload` pick strips the trigger and calls `fileInputRef.current?.click()` (EditableBlockTree.tsx:443-449); the native dialog opens.
2. The textarea blurs (mouse-click on the autocomplete row, or the native dialog taking focus) → `onBlurBlock` → `setFocus(null)` (web/src/outline/useOutline.ts:234-239). Evidence: the stripped-empty block was flushed and persisted server-side while the picker was open.
3. Focus null → BlockInput unmounts → the file input is detached from the DOM.
4. The picker's `change` event fires on the detached input; React's root-delegated `onChange` never dispatches → `onPickUpload` never runs. Silent no-op.

Compounding bug: `onFiles` in useOutline.ts:282-286 swallows ALL upload errors with an empty `catch {}` — even genuine failures (server down, 413, offline shim's OfflineError) give zero user feedback.

Note: paste (Cmd-V) and drag-drop are unaffected — they read files synchronously from the event while still focused.

## Fix

- [ ] Move the upload `<input type="file">` out of the focus-scoped `BlockInput` so it survives blur/unmount while the picker is open (e.g. single input owned by `EditableBlockTree` root, with a ref holding target uid + splice offset)
- [ ] Failing test first (TDD): choosing a file after the block has blurred/unmounted still calls `onFiles` with the right uid/offset and splices the asset markdown
- [ ] Surface upload failures to the user instead of the silent `catch {}` in useOutline `onFiles` (keep the don't-half-splice behaviour)
- [ ] Unit coverage for the error-surfacing path
- [ ] `cd web && pnpm verify` green
