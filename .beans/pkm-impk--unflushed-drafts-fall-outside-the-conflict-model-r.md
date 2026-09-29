---
# pkm-impk
title: 'Unflushed drafts fall outside the conflict model: remote text overwritten silently, local text dropped when the block leaves the tree'
status: completed
type: bug
priority: high
created_at: 2026-09-29T13:20:29Z
updated_at: 2026-09-29T13:59:11Z
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
- [x] Docs: `frontend-editor.md` § Drafts and commit points; `sync-and-offline.md` conflict section (order independence; D7's sentence scoped); troubleshooting row
- [x] verify: web typecheck, lint, check:fcis, test:coverage, build; server pytest, pyrefly, ruff (all green in the branch)
- [ ] full Playwright suite, perf/check.sh and merge: run by the orchestrator serially after merge (parallel-executor brief)

## Initial-effect trace

The `initial`-change effect in `useOutline.ts` used to null `pendingRef` without flushing whenever a parent passed an `initial` that was not the session snapshot. Every production parent passes the snapshot array itself, so it normally exits early:

- `PageView.tsx:44` and `EditableSidebarPanel.tsx:34` pass `payload.blocks`, set to `handle.getSnapshot().blocks` in `useOutlinePageLoad.ts:110` and `:134`.
- `Journal.tsx:112` sets `blocks: session.getSnapshot().blocks`, passed at `:217`.

It is still reachable with a live draft: `publish` (`outlineSessions.ts:177`) replaces the snapshot synchronously on every `applyRemote` / `applyLocal`, and a WebSocket batch can land between the parent's `setState` and the passive effect, so the effect sees `initial !== snapshot`. Windows: PageView's resync reload, a parent-read election in `useOutlinePageLoad`, Journal's in-place head reload after `reset`.

Outcome: reachable via a narrow race; now flushes first. `flushNow()` runs before `beginAuthoritativeRead("parent")`, which makes the draft a relevant write, so `transitionOutline` defers the parent tree until that write settles (pinned by `useOutline.reconciliation.test.tsx` "a new parent tree flushes a live draft before adopting it").

## Summary of Changes

- Draft shape: `PendingDraft = { uid, text, base }` (`outline/outlineState.ts`). `captureDraft` sets `base` from the tree on the first change and keeps it across later keystrokes, even after a remote batch changes the tree.
- Flush rule: `pendingTextOps(pending, blocks, pageTitle)` stamps `base_text_hash` = hash of `base` plus `page_title`, and emits the op even when the block has left the tree (remote delete, cross-page move). It sends nothing when `text === base` or the tree already holds `text`. A `null` base carries `page_title` only and `stampBaseTextHashes` hashes it as before.
- History strip: `run()` records the flushed text op through `withoutStamps` (`outline/baseTextHash.ts`), so a redo still hashes the tree at replay time (`useOutline.undo.test.tsx` "run() records UNSTAMPED ops" stays green; mutation-checked).
- Initial effect: a new parent `initial` now calls `flushNow()` before `beginAuthoritativeRead("parent")` instead of nulling the draft (trace above).
- Two component tests that pinned the loss were inverted: `EditablePage.test.tsx` "focused block with a pending draft keeps the draft; it wins on flush" (asserted the remote hash) and "draft for a remotely-deleted block is dropped, not flushed". Added debounced/held x update/delete/cross-page-move cases, first-base-kept, next-draft-bases-on-flushed-text, and Enter-after-remote-update.
- Composed fixture: `shared/fixtures/draft_flush.json`, consumed by `web/src/views/EditablePage.draftFlush.test.tsx` and `server/tests/test_ops_endpoint.py` (both arrival orders keep both texts; a flush after delete lands on the daily note). The web half is red against the pre-branch sources and against a flush-time-base mutation.
- Docs: `frontend-editor.md` § Drafts and commit points (table) and rules-table row; `sync-and-offline.md` § Conflicts at push time (order independence, D7 sentence scoped to conflict copies); `backend.md` fixtures table (`draft_flush.json`, plus the missing `missing_targets.json` row); `troubleshooting.md` Editor row; pkm-xjew D7 bullet updated.
- Review fixes (adversarial review H1/H2/H3/M2/D1):
  - Base from the view, not the tree: `useBlockDraft` reports the text the textarea showed at the first edit of a clean draft (`onDirty` -> new handler `onDraftStart`), and `useOutline` keeps it in `shownRef` (reset to the draft's text after every flush, cleared on blur). `captureDraft(prev, uid, text, blocks, shown)` uses it for a new draft, falling back to the tree. Fixes typing back to the base under a remote edit (H1) and a first keystroke landing before the textarea adopted a remote edit (H3).
  - A pending draft on another block is flushed (`flushOtherDraft`) in `onFocusBlock`, `onDraftStart` and `onDraftChange`, so a draft whose textarea unmounted with no blur (remote delete) is no longer replaced (H2, debounced and held).
  - `run()` leaves a text op whose block is missing from `pre` out of the history entry, so a batch carrying an orphaned draft stays undoable (M2).
  - Docs: the flush table's cross-page-move row (the server applies the edit to the moved block; only a deleted block lands on the daily note), the base-from-the-view paragraph, the flush-before-switch note; troubleshooting row cause updated.
  - Filed pkm-sfp1 (same-page remote move drops the pending draft; predates this branch).
- Re-review fixes (U1, P2):
  - `useBlockDraft.settle()` marks the draft clean and re-runs adoption. `BlockInput` calls it after `onUndo`/`onRedo` and after a paste/drop upload whose `onFiles` promise resolves true (the splice ran). The textarea then shows the undo's, redo's or splice's text, and the next draft is based on it: no spurious `[[conflict]]` after Cmd+Z while typing, and an upload's markdown is no longer overwritten.
  - `OutlineHandlers.onFiles` now returns `Promise<boolean>` (true when the markdown was spliced into the block).
  - Docs: the settle() note in frontend-editor.md § Drafts and commit points; one troubleshooting row.
- Perf: not run in this branch (parallel-executor brief); the orchestrator runs `perf/check.sh` after merge.
