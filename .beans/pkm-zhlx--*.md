
## Checklist

- [x] Red tests: copy block reference, Cmd/Ctrl+C selection, read-only, clear on next copy
- [x] NoticeKind "copy" (error tone), handlers.onCopyNotice, copy-notice pre-wrap
- [x] frontend.md paragraph updated

## Summary of Changes

Symptom: Copy block reference / Cmd+C on a block selection does nothing when the clipboard is refused. Cause: EditableBlockTree ignored copyText's false. Fix: both callers go through copyAndReport, which clears the outline's new "copy" notice, then sets "Copying failed. Select and copy it: <text>" (full text, pre-wrap) on a refusal, via handlers.onCopyNotice. Rule stated in docs/architecture/frontend.md § Popovers and menus (clipboard paragraph).

The fallback (non-owner) mount needs no copy notice: its bullets render no block menu and its selection handler returns early, so it cannot copy.
