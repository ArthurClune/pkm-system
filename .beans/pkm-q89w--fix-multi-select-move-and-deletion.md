---
# pkm-q89w
title: Fix multi-select move and deletion
status: completed
type: bug
priority: normal
created_at: 2026-07-14T21:14:34Z
updated_at: 2026-07-16T15:28:46Z
---

Multi-block selection is only partially functional: moving a selection moves only the first selected block, and selected blocks cannot be deleted as a set.

## Acceptance Criteria

- [x] Moving a multi-block selection moves every selected block while preserving their intended order.
- [x] Deleting a multi-block selection deletes all selected blocks.
- [x] Deleting more than 5 blocks requires explicit user confirmation before deletion proceeds.
- [x] Deleting 5 or fewer selected blocks does not require the large-deletion confirmation.
- [x] Automated tests cover multi-block move, multi-block deletion, and the confirmation threshold.

## Summary of Changes

Root cause, two halves. Drag: `DragSource` only ever carried one uid, so
dragging a block that was part of a multi-block selection moved just that
block — the reported "moving a selection moves only the first selected
block". Keyboard: while a selection (Shift+Arrow, pkm-9b8n) is active, focus
moves to the tree container (no textarea is focused), but the tree's
`onKeyDown` in `EditableBlockTree.tsx` only handled Shift+Arrow (extend),
Cmd/Ctrl+C (copy), Escape (clear), and a plain arrow (collapse-to-edit-head).
Alt+Arrow (move) and Backspace/Delete were never wired for the
selection-active case — the only "move" and "delete" handlers
(`onMoveUp`/`onMoveDown`/`onBackspaceAtStart`) were single-uid and only
reachable from a *focused* block's own keydown policy, which cannot fire
while a selection (no focus) is active. Both paths are fixed.

Fix, functional core (`web/src/outline/edits.ts`):
- `moveSelectionUp`/`moveSelectionDown`: move a *contiguous run of sibling*
  selected blocks as a group by moving the single non-selected neighbour
  (the sibling just above/below the run) to the far side of the run — one
  `move` op regardless of selection size, and the selected blocks never move
  relative to each other. No-ops when the uids aren't a same-parent
  contiguous run (mirrors the existing single-block move's same-parent
  restriction) or already at an edge.
- `deleteSelection`: emits one `delete` op per selection "root" (a selected
  uid with no selected ancestor) — deleting a block already cascades away its
  whole subtree, so a selected descendant needs no separate op. Focus falls
  back to the visible block just before the run, then the sibling right
  after the last deleted root, else null.

Fix, functional core (`web/src/outline/blockSelection.ts`):
- `needsDeleteConfirmation(count)` / `LARGE_DELETE_THRESHOLD = 5`: pure
  threshold check reused by the imperative shell.
- `selectionDragUids(blocks, sel, grabbed)`: the uids a drag should carry —
  the selection's root uids in document order when the grabbed block is in
  the selection, else null (plain single-block drag).

Fix, functional core — drag (`web/src/outline/tree.ts`, `edits.ts`, `dnd.ts`):
- `tree.ts` `selectionRoots(blocks, uids)`: reduce a uid set to uids with no
  ancestor in the set (shared by delete, group move, and drag).
- `edits.ts` `groupMoveOps(uids, parentUid, orderIdx)` and
  `moveBlocksTo(...)`: one move op per selection root at consecutive
  order_idx slots — sequential application (client applyOps mirrors server
  ops_apply) lands the run contiguously in its original order.
- `dnd.ts`: `DragSource` gains optional `uids` (the dragged group's roots);
  `dropRows` excludes every dragged subtree; `resolveDrop`'s same-position
  check applies the whole group's ops. Dropping inside the selection is
  impossible by construction (selected rows are excluded from boundaries),
  and dropping the group back where it sits resolves to null (no-op), same
  as single-block drag.

Fix, imperative shell:
- `web/src/outline/useOutline.ts`: new handlers `onMoveSelectionUp`,
  `onMoveSelectionDown`, `onDeleteBlockSelection` — the latter calls
  `window.confirm` (same pattern as the existing page-delete confirmation in
  `TopBar.tsx`) only when `needsDeleteConfirmation` is true, and clears the
  selection once the delete proceeds.
- `web/src/components/EditableBlockTree.tsx`: tree-level `onKeyDown` now
  also handles Alt+ArrowUp/Down (→ move handlers) and Backspace/Delete (→
  delete handler) while a selection is active. `OutlineHandlers` interface
  gained the three new methods.
- Drag shell: `web/src/views/EditablePage.tsx` `onDragStartBlock` attaches
  the selection's root uids when the grabbed block is inside it (an
  unselected block drags alone, as before); `web/src/dnd/DndContext.tsx`
  `OutlineDndApi.moveTo` now takes `uids: string[]`, and `drop()` handles
  groups on both the same-page path (one op batch via the registered
  outline or direct enqueue) and the cross-page path (per-uid subtree
  surgery, sequential move ops, per-node insert replays);
  `web/src/outline/useOutline.ts` `dnd.moveTo` delegates to `moveBlocksTo`.

Tests added:
- `web/src/outline/edits.test.ts`: `moveSelectionUp`/`moveSelectionDown`
  (group move, order preservation, edge/no-op/non-sibling cases) and
  `deleteSelection` (multi-delete, parent+child cascade, focus fallback,
  empty-selection no-op).
- `web/src/outline/blockSelection.test.ts`: `needsDeleteConfirmation`
  threshold (<=5 vs >5).
- `web/src/components/EditableBlockTree.test.tsx`: Alt+Arrow and
  Backspace/Delete dispatch the new handlers while a selection is active.
- `web/src/outline/useOutline.selection.test.tsx` (new file): end-to-end
  through the real handlers — group move emits the single expected op and
  reorders the tree; delete of <=5 blocks proceeds without `window.confirm`;
  delete of >5 blocks calls `confirm` and honours both cancel (no-op,
  selection preserved) and confirm (ops sent, selection cleared).
- Drag tests: `edits.test.ts` `moveBlocksTo` (contiguous run, cross-parent
  roots, parent+child cascade, new-parent reparent, empty no-op);
  `blockSelection.test.ts` `selectionDragUids` (in/outside selection, root
  reduction); `dnd.test.ts` group `dropRows` exclusion and `resolveDrop`
  (group target + same-position null); `DndContext.test.tsx` same-page and
  cross-page group drops (sequential ops, per-node surgery and replays);
  `useOutline.dnd.test.tsx` group `moveTo` optimistic reorder;
  `EditableBlockTree.dnd.test.tsx` full-wiring tests — dragging a selected
  block moves the whole selection, dragging an unselected block moves only
  itself.

Verification: `cd web && E2E_PORT=8982 pnpm verify` — typecheck, lint,
FCIS boundary check (101 modules, no violations), unit tests with coverage
(1057 tests, all passing — meets enforced thresholds), production build
(budgets OK), and Playwright E2E (7/7 passed). No E2E for multi-select
existed to extend, so coverage is unit + component level per the task's
guidance.

Branch: `fix/pkm-q89w-multi-select-move-and-deletion`
Worktree: `/Users/arthur/code/llm/pkm/.claude/worktrees/agent-a8492dca9dbd8191c`
