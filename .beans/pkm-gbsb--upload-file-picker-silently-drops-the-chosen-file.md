---
# pkm-gbsb
title: /upload file picker silently drops the chosen file when the block blurs
status: completed
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

- [x] Move the upload `<input type="file">` out of the focus-scoped `BlockInput` so it survives blur/unmount while the picker is open (e.g. single input owned by `EditableBlockTree` root, with a ref holding target uid + splice offset)
- [x] Failing test first (TDD): choosing a file after the block has blurred/unmounted still calls `onFiles` with the right uid/offset and splices the asset markdown
- [x] Surface upload failures to the user instead of the silent `catch {}` in useOutline `onFiles` (keep the don't-half-splice behaviour)
- [x] Unit coverage for the error-surfacing path
- [x] `cd web && pnpm verify` green

## Summary of Changes

- `web/src/components/EditableBlockTree.tsx`: the hidden `<input type="file">` (and its `onChange` handler) moved from the focus-scoped `BlockInput` up to the `EditableBlockTree` root, which never unmounts on blur. A new `uploadTargetRef` on the tree records `{uid, at}` set by the `/upload` pick handler (still inside `BlockInput`, via a new `onRequestUpload(uid, at)` callback threaded down through `EditableBlock`). The shared input is rendered once per tree (gated on `!fallback && !readOnly`, same as before), so it survives the native file dialog blurring the textarea and unmounting `BlockInput`.
- `web/src/outline/useOutline.ts`: `onFiles` no longer swallows upload failures with an empty `catch {}`. Failures are collected per-file (`"<filename>: <error message>"`) and surfaced via a new `uploadError: string | null` state on the returned `Outline`, cleared at the start of each new upload attempt or via a new `dismissUploadError()`. The "don't half-splice on partial failure" behaviour is unchanged — only files that upload successfully get spliced in.
- `web/src/views/EditablePage.tsx`: renders `outline.uploadError` as `<p className="error upload-error" role="alert">` (reusing the codebase's existing inline-error convention, e.g. `PageTitle.tsx`) with a `.btn-secondary`-styled Dismiss button, shown next to the outline whose upload failed rather than as a page-global banner.
- `web/src/styles.css`: minimal `.upload-error` layout rule (flex row, gap) for the message + dismiss button.
- Tests: `web/src/components/EditableBlockTree.test.tsx` gained a regression test that reproduces the exact bug (pick /upload, blur the block so `BlockInput` unmounts, then fire `change` on the still-mounted shared input and assert `onFiles` fires with the right uid/offset), plus tests for "exactly one upload input in the tree" and "no upload input when readOnly". New `web/src/outline/useOutline.upload.test.tsx` covers `onFiles`: successful splice, a failed upload setting a filename-bearing `uploadError` with text left untouched, `dismissUploadError`, and a new upload attempt clearing a stale error.
- All new tests were written first and confirmed failing against the pre-fix code before implementing.
