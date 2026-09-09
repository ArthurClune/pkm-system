---
# pkm-zrjc
title: '/upload leaves the block as a textarea again: the pick must not rely on the dialog blurring it'
status: completed
type: bug
priority: normal
created_at: 2026-09-09T18:19:26Z
updated_at: 2026-09-09T18:24:17Z
---

## Symptom

After `/upload` (image or document), the block stays as a raw textarea and the uploaded asset only renders once the cursor moves off the line. This is the pkm-s6i6 symptom again; observed in prod 2026-09-09 ~18:08 BST (IMG_0906.jpeg) and ~18:02 (statement.pdf).

## Root cause

pkm-s6i6 made onFiles restore focus only when the target block still owns it, on the assumption that the native file dialog blurs the textarea (focus -> null) before the upload starts. That assumption is browser behaviour, not ours. The onFiles / useOutline / BlockInput code is unchanged since 3285fa9; what changed is that the dialog no longer blurs the focused textarea in the browser being used (Brave was updated 2026-08-28; Safari 26.6.2; the iPad picker sheet), so at completion the block still owns focus, run() restores it, and BlockInput re-renders as a textarea instead of the read-only row that renders the image. Because the draft is dirty from the stripped trigger and the tree jumped straight to the spliced markdown, useBlockDraft never adopts it and the textarea shows an empty draft until blur.

Reproduced in jsdom with the real useOutline wired to EditableBlockTree: simulating the blur before the pick renders the <img>; skipping it leaves a focused empty textarea with the markdown only in the tree.

## Fix

Make the /upload path independent of whether the dialog blurs: the pick itself gives up the block (handlers.onBlurBlock after stripping the trigger, before opening the tree-owned picker), so the block renders read-only while the picker is open and the s6i6 conditional is true by construction on this path. Paste and drag-drop are unchanged.

- [x] Failing integration test: /upload pick with no simulated blur renders the image and leaves no textarea
- [x] Tree-level test: picking /upload calls onBlurBlock for the block
- [x] Implement the blur-on-pick in BlockInput's upload pick; update the s6i6 / gbsb comments that describe the dialog as the thing that blurs
- [x] cd web && pnpm verify green

## Summary of Changes

BlockInput's `/upload` pick now calls `handlers.onBlurBlock(node.uid)` after stripping the trigger and before opening the tree-owned file input, so the block gives up focus itself and renders read-only while the picker is open. onFiles' pkm-s6i6 conditional ("re-focus only if the block still owns focus") is therefore true by construction on the dialog path, whatever the browser does with focus when the dialog opens. Paste and drag-drop unchanged. New integration test `EditableBlockTree.upload.test.tsx` wires the real useOutline to EditableBlockTree, picks /upload with no simulated blur, and asserts no textarea remains and the <img> renders (failed before the fix). The pkm-coz9 tree test now asserts onBlurBlock is called after onDraftChange. Comments in BlockInput, EditableBlockTree, useOutline and useOutline.upload.test updated; frontend.md gains the invariant in the slash-commands bullet and a symptom row. pnpm verify green (typecheck, 2572 unit tests / 167 files, 57 e2e).
