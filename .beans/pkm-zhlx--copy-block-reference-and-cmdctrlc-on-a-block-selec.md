---
# pkm-zhlx
title: Copy block reference and Cmd/Ctrl+C on a block selection show nothing when the copy fails
status: completed
type: bug
priority: normal
created_at: 2026-11-11T09:51:07Z
updated_at: 2026-11-11T14:03:23Z
parent: pkm-4gda
---

Found by the 2026-11-11 docs re-check. In web/src/components/EditableBlockTree.tsx the block menu's Copy block reference and the Cmd/Ctrl+C handler for a block selection call copyText and ignore a false result, so a failed clipboard write is silent. Files and DroppedDraftNotice show the text to copy by hand instead. frontend.md § Popovers and menus names which callers do which. Decide whether these two should show a notice (the outline notice slot) and add a test per caller.


## Checklist

- [x] Red tests: copy block reference, Cmd/Ctrl+C selection, read-only, clear on next copy
- [x] NoticeKind "copy" (error tone), handlers.onCopyNotice, copy-notice pre-wrap
- [x] frontend.md paragraph updated

## Summary of Changes

Symptom: Copy block reference / Cmd+C on a block selection does nothing when the clipboard is refused. Cause: EditableBlockTree ignored copyText's false. Fix: both callers go through copyAndReport, which clears the outline's new "copy" notice, then sets "Copying failed. Select and copy it: <text>" (full text, pre-wrap) on a refusal, via handlers.onCopyNotice. Rule stated in docs/architecture/frontend.md § Popovers and menus (clipboard paragraph).

The fallback (non-owner) mount needs no copy notice: its bullets render no block menu and its selection handler returns early, so it cannot copy.
