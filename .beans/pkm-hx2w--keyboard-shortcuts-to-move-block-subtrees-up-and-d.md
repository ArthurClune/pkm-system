---
# pkm-hx2w
title: Keyboard shortcuts to move block subtrees up and down
status: completed
type: feature
priority: normal
created_at: 2026-07-14T21:22:43Z
updated_at: 2026-07-16T17:22:00Z
---

Add macOS keyboard shortcuts for moving the current block and its complete descendant subtree vertically within the page.

## Acceptance Criteria

- [x] Shift-Cmd-Up moves the current block upward when a valid destination exists.
- [x] Shift-Cmd-Down moves the current block downward when a valid destination exists.
- [x] The current block and all of its descendants move together as one subtree.
- [x] The moved block and every descendant preserve their hierarchy levels and parent/child relationships.
- [x] A move is a no-op when the destination cannot retain the subtree root at its existing hierarchy level (for example, moving a level-three block to a position that would require it to become level one).
- [x] Focus remains on the moved block after a successful move.
- [x] Automated tests cover upward and downward moves, subtree preservation, hierarchy-level preservation, and invalid-move no-ops.

## Summary of Changes

Implemented depth-preserving Shift-Cmd-Up/Down subtree moves following the
existing three-layer FCIS pattern used by Alt-Arrow's single-block move:

- `web/src/outline/edits.ts`: `moveSubtreeUp`/`moveSubtreeDown`. A previous/
  next sibling means a plain sibling swap (delegates to `moveBlockUp`/
  `moveBlockDown`); otherwise, if the parent has an adjacent sibling, the
  block becomes that sibling's last/first child (same depth, one op via the
  existing `move` op — children travel with it automatically). No parent
  sibling to escape into is a no-op; the walk never goes past the parent's
  immediate sibling, so a block never becomes shallower.
- `web/src/outline/keyboardPolicy.ts`: new `move-subtree-up`/
  `move-subtree-down` `KeyDecision` variants; the Shift+Meta+Arrow branch is
  checked before the plain-Shift block-selection-start branch (same key
  shape) so the chord can't fall through to selection, while plain
  Shift-Arrow is unaffected. Read-only suppresses it, same as Alt-Arrow move.
- `web/src/components/EditableBlockTree.tsx`: `onMoveSubtreeUp`/
  `onMoveSubtreeDown` added to `OutlineHandlers`; new switch cases call them
  with `preventDefault()` (macOS reserves Shift-Cmd-Arrow for text
  selection).
- `web/src/outline/useOutline.ts`: handlers funnel through `run()` exactly
  like the existing move handlers. Focus intentionally isn't touched
  (`focus: null` = "leave it") — the block's own textarea just gets
  reparented, not unmounted, so focus survives the move for free, matching
  moveBlockUp/moveBlockDown's own convention.

Tests: 9 new cases in `edits.test.ts` (sibling swap, cross-parent move
becoming last/first child, subtree-carried-intact, depth preservation,
top-level no-op, and the level-3 "would become shallower" no-op) against a
new three-level `deepTree()` fixture; 6 new cases in `keyboardPolicy.test.ts`
covering the decision, precedence over plain Shift-Arrow, non-interference
with Alt-Arrow, and the read-only/Ctrl/Alt guards; one wiring assertion pair
added to `EditableBlockTree.test.tsx`'s existing keyboard-map test.

Verification: `pnpm typecheck`, `pnpm test:unit` (1073 tests across 81
files), and `E2E_PORT=8981 pnpm verify` (typecheck + lint + FCIS boundary
check + coverage-enforced unit tests + build + 7 Playwright E2E specs) all
passed clean on the first full run.
