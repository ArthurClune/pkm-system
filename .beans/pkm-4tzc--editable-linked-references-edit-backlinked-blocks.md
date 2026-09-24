---
# pkm-4tzc
title: Editable linked references (edit backlinked blocks in place)
status: todo
type: feature
priority: deferred
created_at: 2026-09-24T13:31:11Z
updated_at: 2026-09-24T13:31:11Z
---

## Want

Linked references, on a page and under each day in the journal scroll, should be editable in place, and the edit should change the original block. For example, on "September 24th, 2026" a `{{TODO}}` block from another page that references the day shows up under Linked references; ticking it or editing its text there should update the source page.

Arthur's preference if built: the **full outliner** (Roam/Logseq style), which beats nothing. Parked 2026-09-24 as not key.

## What exists today

- `BacklinksSection` → `BacklinkGroupList` renders each item from a snapshot `{uid, text, breadcrumbs}` (`BacklinkItem`) through `InlineSegments`. Items are static: no children, no editor.
- `TodoCheckbox` is disabled wherever `BlockEditContext` is null, which includes backlinks.
- `JournalDayReferences` reuses `BacklinksSection` with the day's backlinks from `/api/journal`. `BacklinksSection` snapshots `initial` into state and doesn't update from later payloads.
- Precedent for writing to a page from outside its editor: `undoManager.ts` takes `peekOutlineSession(title)`, stamps a `base_text_hash` against that session's tree, calls `sync.enqueue(ops, ["page", title])`, then `handle.applyLocal(write, ops)` if the session is mounted. `UpdateTextOp` carries `base_text_hash`, so a conflicting edit produces a `[[conflict]]` sibling (last write wins) instead of overwriting silently.

## Three tiers of complexity

1. **TODO toggle only: small.** Swap the snapshot's checkbox for a live one that sends `update_text` (via `grammar/todo.ts::toggleTodo`) down the undoManager-style path, with an optimistic local override of the item's text. The hash can come from the snapshot text when no session is mounted. Offline, sync and conflicts work unchanged.
2. **Single-block text edit: medium.** Click an item and it becomes a textarea with autocomplete; typing is saved after a short pause and on blur; Enter and Tab don't restructure. The work is running `BlockInput` without `useOutline`, since it's wired to the `OutlineHandlers` port (about 30 callbacks), so it needs a narrow single-block adapter. The rule that text edits go through the draft/key-edit path still applies.
3. **Full outliner: large.** Show the referencing block's children and edit them like the real page (Enter splits, Tab indents, drag, undo). Hard parts:
   - **Editing rights.** `outlineSessions.claimEditor` grants a title's editor lease first come, first served, and later claimants wait in a queue. In the journal scroll a referencing day is usually mounted editable a few days up and already holds the lease, so its block under another day's references would be read-only. The fix is to move the lease on focus, with the losing view flushing its draft first. That changes the "one editable view per title" invariant (see frontend-editor.md, "Per-title outline sessions").
   - **Projection.** Every backlink group would mount the source page's full session and render only the referencing subtrees. There's no zoom/subtree view today. `EditableBlockTree` and `useOutline` assume they own the whole forest, so structural edits need projection rules. For example, Tab on a projection root would indent it under a sibling that isn't shown, and arrow navigation has to cross between groups and back into the host page.
   - **Cost.** One session and one full page read per source page, instead of a single backlinks read. Loading on first focus would keep scroll cost down (see pkm-5fak: the journal moved backlinks into the batched payload to avoid per-day page reads).
   - **Payload.** `BacklinkItem` has no children today; either add them or read from the session once it's mounted.

## Behaviour to keep whatever the tier

- If an edit removes the reference (say `[[September 24th, 2026]]` is deleted), the item stays until the next refresh rather than vanishing mid-edit (Roam does the same).
- Read-only surfaces (the `fallback` trees, `BlockRefBacklinksPopover`) stay read-only.

## Suggested path if revived

Build tier 1, then tier 2, as stepping stones: they're useful alone and create the write path tier 3 needs. Then design lease-on-focus and projected trees as their own spec.
