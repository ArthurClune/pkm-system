---
# pkm-impk
title: 'Unflushed drafts fall outside the conflict model: remote text overwritten silently, local text dropped when the block leaves the tree'
status: in-progress
type: bug
priority: high
created_at: 2026-09-29T13:20:29Z
updated_at: 2026-09-29T13:48:58Z
parent: pkm-a4t2
---

Review F3 (P1, pre-existing). A draft is `{ uid, text }`
(`useOutline.ts`), with nothing about the text it started from.

(a) Remote ops always reach the tree, including under the focused block;
`useBlockDraft` keeps showing the draft while the tree holds the remote text.
At flush, `stampBaseTextHashes` hashes the tree, which already carries the
remote text, so the server sees a matching hash, applies a clean edit, and the
remote author's text is overwritten with no conflict copy. Had the local flush
arrived first the remote edit would have forked a conflict, so the outcome
depends on arrival order.

(b) When a remote batch deletes the block, or a cross-page move takes it out
of this outline, `pendingTextOps` returns nothing and `takePendingTextOps` has
already cleared the draft, so the local text is dropped. The "would doom the
whole batch" rationale is superseded: the server classifies any missing-block
`update_text` as an orphan edit and lands it on today's daily note.
`outlineState.test.ts` pins the drop.

Window: everything typed since the last 500 ms pause; a held draft (caret in
a `[[` or `#` token) has no timer and can sit indefinitely.

Design: spec § F3 — the draft records `base`, the tree text when it was
created; `pendingTextOps` stamps `base_text_hash` and `page_title` from it
and emits the op even when the block is absent, skipping only when nothing
changed or the present node already has the text.

## Todo

- [x] Invert `outlineState.test.ts` "drops a pending draft whose block a remote batch deleted": flushed, stamped with the base hash
- [x] Draft becomes `{ uid, text, base }`; `pendingTextOps(pending, blocks, pageTitle)` per the spec; `stampBaseTextHashes` already leaves a stamped op alone
- [x] Tests: remote update during a debounced draft flushes with the pre-remote hash; remote delete and remote cross-page move during a debounced and a held draft both flush; `text === base` and an identical remote edit both suppress
- [x] Trace the `initial`-change effect in `useOutline.ts` that clears a draft without flushing; flush first if a production parent reaches it with a live draft; record the outcome here
- [ ] Docs: `frontend-editor.md` § Drafts and commit points; `sync-and-offline.md` conflict section (order independence; D7's sentence scoped); troubleshooting row
- [ ] verify, perf, merge

## Initial-effect trace

The `initial`-change effect in `useOutline.ts` used to null `pendingRef` without flushing whenever a parent passed an `initial` that was not the session snapshot. Every production parent passes the snapshot array itself, so it normally exits early:

- `PageView.tsx:44` and `EditableSidebarPanel.tsx:34` pass `payload.blocks`, set to `handle.getSnapshot().blocks` in `useOutlinePageLoad.ts:110` and `:134`.
- `Journal.tsx:112` sets `blocks: session.getSnapshot().blocks`, passed at `:217`.

It is still reachable with a live draft: `publish` (`outlineSessions.ts:177`) replaces the snapshot synchronously on every `applyRemote` / `applyLocal`, and a WebSocket batch can land between the parent's `setState` and the passive effect, so the effect sees `initial !== snapshot`. Windows: PageView's resync reload, a parent-read election in `useOutlinePageLoad`, Journal's in-place head reload after `reset`.

Outcome: reachable via a narrow race; now flushes first. `flushNow()` runs before `beginAuthoritativeRead("parent")`, which makes the draft a relevant write, so `transitionOutline` defers the parent tree until that write settles (pinned by `useOutline.reconciliation.test.tsx` "a new parent tree flushes a live draft before adopting it").
