---
# pkm-tmtf
title: Focused block without a draft must adopt remote text updates
status: completed
type: bug
priority: high
created_at: 2026-07-10T10:56:40Z
updated_at: 2026-07-10T11:20:49Z
parent: pkm-m309
---

Review finding 2 (Important). useOutline (web/src/outline/useOutline.ts:119-136) filters remote update_text ops by focused-block UID alone, but focus does not imply a pending draft. Click into a block, type nothing, and a remote update from another client is committed server-side but never shown locally — the focused client keeps stale text until an unrelated refetch, and a later edit from it can overwrite the unseen remote change. Current behavior is codified by web/src/views/EditablePage.test.tsx:77-86, which will need updating.

Fix direction per review: base conflict behavior on an actual pending draft, not focus. E.g. apply remote text to the underlying block tree even while the textarea holds a local component draft; a real draft flush then becomes the next legitimate last-writer. The no-draft case must adopt the remote value.

## Checklist
- [x] Apply remote update_text to block tree when focused block has no pending local draft
- [x] Decide and implement LWW behavior when a real local draft exists
- [x] Update EditablePage.test.tsx:77-86 to the new contract
- [x] Regression: focused, no local change → remote update displayed/adopted
- [x] Regression: focused with pending draft → chosen LWW behavior verified
- [x] Regression: focus then blur without editing after remote update → client and server consistent

## Resolution

Remote `update_text` ops now always apply to the block tree (removed the
focus-based filter in `useOutline.ts`). Display-time LWW moved into
`BlockInput` (`EditableBlockTree.tsx`): a `dirtyRef` tracks unflushed local
typing; a `node.text` effect adopts tree changes when not dirty and keeps the
local draft when dirty. A dirty draft's debounce flush is the next writer.

## Summary of Changes

- useOutline no longer filters remote update_text by focus; remote ops always land on the block tree.
- Display-time LWW moved into EditableBlockTree via an explicit dirtyRef (set synchronously on typing, cleared when node.text catches up): pending draft wins until flush; clean textarea adopts remote immediately; blur-without-typing stays consistent.
- Three regression tests added/rewritten in EditablePage.test.tsx; 255 web tests + typecheck pass. Merged to main (--no-ff).
- Deferred minors (final-review triage): IME mid-composition adoption, dirty-clear by value equality, caret position on adoption.
