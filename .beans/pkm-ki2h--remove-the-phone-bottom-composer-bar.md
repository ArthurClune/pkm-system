---
# pkm-ki2h
title: Remove the phone bottom composer bar
status: completed
type: task
priority: normal
created_at: 2026-10-20T18:04:11Z
updated_at: 2026-10-20T18:08:02Z
---

Arthur never uses the phone-only bottom Composer (append text box + photo picker + Add); /upload covers uploads and phones edit the outline directly. Remove it.

- [x] Delete Composer component and its tests
- [x] Remove composer prop plumbing (EditablePage, PageView, Journal) and appendBlock if now unused
- [x] Remove composer CSS and style tests
- [x] Update architecture docs
- [x] Verify (typecheck, unit, e2e)

## Summary of Changes

Deleted `Composer.tsx` and its tests, the `composer` prop on `EditablePage` (and its callers in `PageView`/`Journal`), `Outline.appendBlock` (its only caller), the `.composer*` CSS and the phone `.main-pane` padding override it needed, and the style-test assertions on those rules. Comments and docs that described autocomplete as shared with the Composer now describe `BlockInput` alone. Uploads stay available via `/upload`, paste and drag-drop.
