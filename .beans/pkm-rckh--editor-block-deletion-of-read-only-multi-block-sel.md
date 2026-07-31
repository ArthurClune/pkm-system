---
# pkm-rckh
title: 'Editor: block deletion of read-only multi-block selections'
status: completed
type: bug
priority: high
created_at: 2026-07-31T16:05:42Z
updated_at: 2026-07-31T19:27:48Z
parent: pkm-6phf
---

Finding 3 of epic pkm-6phf (web review).

**References:** web/src/components/EditableBlockTree.tsx:149-180

Movement and indentation check readOnly, but Backspace/Delete unconditionally invokes onDeleteBlockSelection(). A selection created while editable can still be destroyed after synchronization changes the outline to read-only.

**Direction:** Gate selection deletion on !readOnly and test the editable-to-read-only transition.

- [x] Add a read-only transition regression test
- [x] Gate destructive selection handling

## Summary of Changes

The `EditableBlockTree.onKeyDown` handler (lines 178-185) now gates Backspace/Delete on `!readOnly`, matching the existing pattern for Tab and Shift+Cmd+Arrow mutations. The gate prevents handlers from being called when the outline is read-only, and also prevents `preventDefault()` so unhandled events pass through.

This component-level gate is the complete fix because `useOutline`'s `onDeleteBlockSelection` handler has no editability check — the decision belongs in the component rather than the handler. `keyboardPolicy.ts` was considered but rejected as the home: it owns the focused-textarea policy; the selection chain has no policy module and lives entirely in the component.

A selection made while editable can now safely outlive the switch to read-only (socket drop, quota exhaustion offline, stalled replica — all valid scenarios that require non-destructive state after the flip).
