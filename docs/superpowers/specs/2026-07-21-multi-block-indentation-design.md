# Multi-Block Tab Indentation — Design (pkm-0ovd)

Date: 2026-07-21
Status: approved by Arthur

## Goal

When a block selection is active, Tab and Shift-Tab change the selected
structure's depth just as they do for one focused block:

- Tab indents every selected block by exactly one level.
- Shift-Tab outdents every selected block by exactly one level.
- Relative order and internal parent/child relationships are preserved.
- The gesture is atomic. If any selected root cannot move exactly one level,
  none of the selection moves.
- Selected sibling blocks never staircase under one another during one
  gesture.

The selection remains active after success or a no-op so the user can continue
working with the same blocks.

## Root cause

Single-block Tab and Shift-Tab are owned by the focused block's textarea.
`decideEditorKey` maps the keys to `indent` and `outdent`, and `BlockInput`
dispatches the corresponding UID handler.

Starting a multi-block selection deliberately removes the textarea and moves
focus to `EditableBlockTree`'s tree container. That container handles selection
extension, copy, group movement, deletion, and selection exit, but has no Tab
branch. `OutlineHandlers`, `useOutline`, and the pure edit layer likewise have
no selection-level indent or outdent command. The browser therefore receives
an unhandled Tab rather than a structural edit.

## Semantics

### Selection roots and sibling runs

The command begins with the selected visible UIDs in document order. It reduces
them with `selectionRoots`: a selected descendant whose ancestor is also
selected does not receive its own move operation because it travels with the
ancestor's subtree.

The remaining roots are partitioned against the original tree into contiguous
sibling runs. Roots are in the same run only when they have the same original
parent and consecutive sibling positions. This supports selections spanning
multiple nesting levels without making one root's move determine another
root's destination.

A selected root carries its complete subtree, including descendants outside
the visible selection. This matches existing single-block structural edits.
Every selected descendant inside that subtree consequently changes absolute
depth by the same one level while its hierarchy remains intact.

### Tab

Preflight every selected root run against the original tree. Each run must have
an immediately preceding sibling. If any run is first at its level, Tab is an
all-or-nothing no-op.

On success, the preceding sibling becomes the parent for the entire run. All
roots in the run are appended as consecutive children in their original order.
If the new parent is collapsed, it is expanded before the moves, matching
`indentBlock`.

Destinations are fixed during preflight, before any move is applied. The second
selected sibling therefore cannot use the first selected sibling as its new
parent; all roots in a run move one level and no staircase is created.

### Shift-Tab

Preflight every selected root run against the original tree. Every run must
have a parent. A top-level selected block is at the maximum left edge, so if
any run is top-level Shift-Tab is an all-or-nothing no-op.

On success, each run moves beneath its former grandparent, or to page top level
when its former parent was top-level. Its roots become consecutive siblings
immediately after the former parent, preserving their original order. This is
the group equivalent of `outdentBlock`.

### Repeated gestures

One key gesture changes depth by at most one level. A later Tab or Shift-Tab is
a new gesture and is evaluated against the resulting tree, exactly as for one
focused block. It succeeds only when every then-current selected root is
eligible.

## Architecture

### Functional Core: `web/src/outline/edits.ts`

Add dedicated pure selection commands beside `indentBlock` and
`outdentBlock`:

```ts
export function indentSelection(
  blocks: BlockNode[], pageTitle: string, uids: string[],
): EditResult

export function outdentSelection(
  blocks: BlockNode[], pageTitle: string, uids: string[],
): EditResult
```

Each command performs root reduction, original-tree run discovery, complete
preflight, and only then operation generation. Operation generation preserves
run order and uses the existing sequential `MoveOp` insertion semantics. The
commands return the standard `EditResult`, with `focus: null`; they do not own
React state, persistence, or keyboard concerns.

This is intentionally not a generic desired-tree diff engine. Repeatedly
calling the single-block commands is also rejected: each call would observe
the prior call's mutation and could staircase siblings or make behavior depend
on iteration order.

### Imperative Shell: `web/src/components/EditableBlockTree.tsx`

Extend `OutlineHandlers` with selection-level indent and outdent callbacks.
While an editable selection owns tree focus, the tree-level keyboard handler
intercepts:

- Tab as selection indent.
- Shift-Tab as selection outdent.

The handler calls `preventDefault()` even when pure preflight later returns a
no-op. This keeps focus on the selected tree and matches the focused textarea's
single-block behavior. Read-only and fallback trees do not dispatch structural
selection edits.

### Imperative Shell: `web/src/outline/useOutline.ts`

The new handlers capture the current `BlockSelection`, derive `selectedUids`
from the exact tree passed into `run`, and call the corresponding pure command.
Using `run` preserves the existing structural-edit pipeline:

1. Flush pending text, if any.
2. Plan the complete selection operation from the flushed tree.
3. Apply the operations optimistically.
4. Enqueue one server batch.
5. Record one undo-history entry.

The selection state is not cleared, and the tree container retains keyboard
focus.

### Server and data model

No server, API, replica, or schema changes are required. Nesting already uses
`parent_uid`, and moving a root carries its subtree. Existing batch application
is sequential and transactional, so generated operation batches persist as a
unit and roll back as a unit if server validation rejects an operation.

## Failure handling

The pure commands return an empty operation list without partial movement when:

- The selection is empty.
- A selected UID or its required tree location is missing.
- Root run discovery is inconsistent.
- Any Tab run has no preceding sibling.
- Any Shift-Tab run has no parent.

Read-only selections do not enter the mutation path. No new user-facing error
state is needed; structural edge gestures already behave as no-ops for a
single block.

## Testing

Development follows red-green-refactor.

### Pure edit tests

Add focused cases to `web/src/outline/edits.test.ts` for:

- Same-level selected siblings indenting together under one preceding sibling.
- Selected siblings preserving order rather than staircasing.
- Mixed-level root runs each moving exactly one level.
- A selected parent and descendant emitting no duplicate descendant move.
- Existing nested subtrees retaining their hierarchy.
- A collapsed Tab destination expanding before its run moves.
- One first-sibling run making the entire Tab command a no-op.
- One top-level run making the entire Shift-Tab command a no-op.
- Same-parent outdent roots landing consecutively after their former parent.
- Empty or missing selections returning no operations.

### Component tests

Extend `web/src/components/EditableBlockTree.test.tsx` to prove that:

- Tab dispatches selection indent and prevents browser focus movement.
- Shift-Tab dispatches selection outdent and prevents browser focus movement.
- Read-only selections do not dispatch either mutation.

### Hook and integration tests

Extend selection-focused `useOutline` tests to verify exact enqueued operation
batches and that selection remains active. Cover undo/redo through the existing
history path where additional focused coverage is needed.

### End-to-end test

Add a Playwright scenario that creates real blocks, starts a multi-block
selection with Shift+Arrow, presses Tab, verifies the visible hierarchy, then
presses Shift-Tab and verifies restoration. Confirm keyboard ownership remains
with the selection across both operations.

Run focused unit tests during development and finish with `cd web && pnpm
verify`.

## Out of scope and follow-up

Hierarchy-preserving outline paste is tracked separately as **pkm-tu3a**. It
does not require a generic existing-tree diff engine. That feature can parse
clipboard indentation into a temporary forest and emit ordered `create`
operations anchored at the paste location. It may reuse small tree-ordering
helpers if they prove useful, but no paste abstraction is added as part of
pkm-0ovd.
