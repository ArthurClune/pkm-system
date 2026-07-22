# pkm-69sl Cursor Position Design

## Problem

Cross-block vertical navigation uses inconsistent caret placement. ArrowUp moves focus to the previous visible block with the caret at that block's text end, while ArrowDown moves focus to the next visible block with the caret at position `0`. Users expect vertical navigation into any non-empty block to leave the editor ready to append text at the block end.

This is deterministic application behavior on macOS and iPadOS, not a platform-specific focus timing problem.

## Scope

When keyboard navigation transfers focus between visible blocks:

- ArrowUp places the caret at the destination block's text end.
- ArrowDown places the caret at the destination block's text end.
- ArrowLeft retains its existing behavior of placing the caret at the previous block's text end.
- ArrowRight retains its conventional behavior of placing the caret at the next block's text start.
- An empty destination block uses cursor position `0`, because its start and end are identical.

Pointer or touch focus already requests the clicked block's text end and will not change.

## Design

Change the cursor calculation in `web/src/outline/useOutline.ts`, where `onArrow` resolves the visible destination block and creates the next `FocusTarget`.

Vertical directions and ArrowLeft will use `destination.text.length`. Only ArrowRight will use `0`. The focus state will continue flowing through `EditablePage` and `EditableBlockTree` to `BlockInput`, which already focuses the textarea and applies the supplied cursor.

The change remains in the existing imperative outline hook because it controls navigation and React focus state. No new module, component API, or event handler is needed.

## Testing

Use test-driven development in `web/src/views/EditablePage.test.tsx`:

1. Change the existing boundary-arrow integration test so returning to the non-empty second block with ArrowDown expects its text length instead of `0`.
2. Run that test and confirm it fails because the actual cursor is `0`.
3. Make the minimal production change in `useOutline.ts`.
4. Confirm the focused test passes.
5. Run the complete required web verification with `cd web && pnpm verify`.

The existing test already verifies ArrowUp lands at the previous block's end. Existing editor tests cover pointer focus at text end and empty-block focus at `0`.

## Non-goals

- Changing horizontal boundary navigation semantics.
- Mapping a pointer click to the nearest visual character.
- Changing iPadOS focus timing or replacing React focus effects.
- Refactoring the broader outline navigation implementation.
