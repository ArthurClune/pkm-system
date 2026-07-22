# Unified Block Move Shortcut Design

**Date:** 2026-07-22  
**Bean:** pkm-8jt5

## Problem

Block movement currently has two keyboard designs:

- Option/Alt+Arrow moves one focused block among its siblings.
- Shift+Cmd+Arrow moves one focused block across sibling and parent boundaries while preserving its depth.

An active multi-block selection follows a third path. Option/Alt+Arrow calls a selection planner that only accepts one contiguous sibling run. Shift+Cmd+Arrow is not recognized as movement by the selection-owned tree container; its generic Shift+Arrow branch extends the selection instead.

This split is difficult to remember and leaves selected ranges unable to use the depth-preserving cross-parent behavior available to a focused block.

## Goals

- Make Shift+Cmd+Up/Down the only block-movement shortcut.
- Use the same depth-preserving movement rules for a focused block and a multi-block selection.
- Move selected structures atomically while preserving absolute depth, hierarchy, and document order.
- Retain Shift+Arrow for starting and extending a block selection.
- Remove the application-level Option/Alt+Arrow movement behavior completely.

## Non-goals

- Changing Tab or Shift+Tab indentation behavior.
- Changing drag-and-drop placement semantics.
- Flattening a mixed-depth selection into one sibling run.
- Moving a block when no destination can preserve its current depth.
- Adding a new non-macOS shortcut in this change.

## Keyboard Contract

### Focused block

- Shift+Cmd+Up/Down moves the focused block and its complete descendant subtree.
- A sibling in the requested direction produces a sibling swap.
- At a sibling-list edge, the block may cross into the adjacent sibling of its parent, becoming that block's last child when moving up or first child when moving down.
- The subtree root keeps its absolute depth. If no such destination exists, the gesture is a no-op.
- Focus remains on the moved block.

This is the existing focused-block Shift+Cmd+Arrow behavior and remains unchanged.

### Active block selection

- Shift+Cmd+Up/Down moves every selected root one depth-preserving position in the requested direction.
- Selected descendants whose ancestor is also selected travel inside that ancestor and do not receive independent move operations.
- Consecutive selected roots sharing a parent form a run and move together, preserving their order.
- A run swaps with an adjacent unselected sibling when one exists.
- At a sibling-list edge, a run may cross the parent boundary using the focused-block rule: it becomes the last children of the parent's previous sibling when moving up, or the first children of the parent's next sibling when moving down.
- Runs at different depths retain those depths rather than being flattened to a common parent.
- The whole gesture is atomic. Destinations are preflighted against the original tree; if any selected run lacks a valid depth-preserving destination, no operations are emitted.
- A collapsed cross-parent destination is expanded before blocks move into it so the selected blocks do not disappear.
- The selection remains active after a successful move.

### Other shortcuts

- Shift+Up/Down continues to start or extend a block selection.
- Tab and Shift+Tab continue to indent and outdent a selection.
- Option/Alt+Up/Down has no application-level block movement behavior. The event is left to normal browser/platform text handling.

## Architecture

### Functional core

`web/src/outline/edits.ts` will own one generalized depth-preserving selection planner. It will:

1. Reduce selected UIDs to hierarchy roots.
2. Group consecutive roots by their original sibling list.
3. Preflight one directional destination for every run against the original tree.
4. Return no operations if any run is ineligible.
5. Emit a deterministic batch that preserves each run's order and subtree structure.
6. Expand collapsed cross-parent destinations before the corresponding move operations.

The single-focused-block functions remain the behavioral reference. Shared private planning helpers may be extracted so focused and selected movement cannot drift, while public focused-block behavior stays compatible.

### Imperative shell

`web/src/outline/keyboardPolicy.ts` will stop mapping Option/Alt+Arrow to movement. Its Shift+Cmd+Arrow decision remains the focused-block route.

`web/src/components/EditableBlockTree.tsx` will recognize Shift+Cmd+Arrow while the tree container owns an active selection. This modifier-specific branch must run before generic Shift+Arrow selection extension. The obsolete selection Option/Alt+Arrow branch will be removed.

`web/src/outline/useOutline.ts` will route selected Shift+Cmd movement through the generalized pure planner and the existing `run()` pipeline, preserving sync, optimistic state, undo history, and selection state.

No server or operation-protocol change is required: block `move` and `set_collapsed` operations already carry subtrees and support the required destinations.

## Failure and Edge Behavior

- Unknown or empty selections are no-ops.
- If any selected run is already at an edge with no same-depth cross-parent destination, the entire gesture is a no-op.
- Read-only outlines do not dispatch movement.
- A selected parent and child move once via the parent root.
- Collapsed selected roots carry hidden descendants without expanding themselves.
- Only collapsed destination blocks are expanded when needed to keep moved content visible.

## Testing

### Pure unit tests

Add coverage for:

- Same-parent selected runs moving up and down.
- Selected runs crossing parent boundaries in both directions.
- Preservation of root order, descendants, and absolute depth.
- Parent-plus-descendant root reduction.
- Mixed-depth selections with independent eligible runs.
- Atomic no-op when any run is ineligible.
- Expansion of collapsed cross-parent destinations.

### Keyboard and component tests

Verify that:

- Option/Alt+Arrow no longer returns or dispatches a move decision.
- Focused Shift+Cmd+Arrow still dispatches subtree movement.
- Selected Shift+Cmd+Arrow dispatches selection movement before generic Shift+Arrow handling.
- Plain Shift+Arrow still extends the selection.
- Read-only selections cannot move.

### Hook and browser tests

Verify through `useOutline` that successful selected moves enqueue one atomic operation batch, update the optimistic tree, preserve the selection, and participate in undo.

Add an end-to-end scenario that creates nested blocks, highlights a run, moves it within a parent and across a parent boundary with Shift+Cmd+Arrow, and confirms the resulting hierarchy and retained selection.

Run the canonical web verification command, `cd web && pnpm verify`.
