---
# pkm-nvxh
title: Remove avoidable per-keystroke outline tree work
status: completed
type: task
priority: normal
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:25Z
updated_at: 2026-08-18T18:35:57Z
parent: pkm-wvvu
---

## Review findings

Frontend correctness/performance flags in `EditableBlockTree` and `outlineState`.

Each rendered block repeatedly walks ancestors to compute `focusInSubtree`, and each outline transition serializes the full tree to detect changes. Both paths run during keystroke batches.

## Acceptance criteria

- [x] Compute the focused block ancestor chain once at the tree root and pass or derive a constant-time subtree-focus value per rendered block
- [x] Replace full-tree `JSON.stringify` comparison with an explicit change signal from operation application or an equally reliable structural result
- [x] Preserve render decisions, focus navigation, no-op transition identity, optimistic updates, and remote batch behavior
- [x] Add correctness tests plus a focused complexity/performance assertion that would catch reintroduction of repeated full-tree work
- [x] Document any changed tree/applyOps contract


## Summary of Changes

**`outline/tree.ts`** gained three exports:

- `ancestorChain(blocks, uid)` — one depth-first pass returning the uid path from
  the outermost ancestor down to `uid`, empty when absent.
- `blocksEqual(a, b)` — field-wise deep compare, short-circuiting on
  reference-equal arrays/nodes and at the first difference.
- `applyOpsWithChange(blocks, ops, pageTitle)` — the existing application plus
  `changed`. **Contract:** the flag is exact, not conservative: an op resolving
  to what the tree already held (text set to itself, a collapse to the current
  state, a move that lands a block back where it was) reports `false`, so
  `false` means the returned tree is `blocksEqual` to the input. A move's
  verdict comes from comparing the source and target sibling arrays only, never
  the tree. `applyOps` is now a wrapper over it and keeps its old signature and
  "returns a new tree" contract, so its ten other callers are untouched.

**`outline/outlineState.ts`**: `changed()` (two `JSON.stringify` calls over the
whole tree per transition) is gone. `withBlocks` now takes the verdict from its
caller: the op paths get it from `applyBatch` (the ops' own flag, OR the stamp),
and the two paths handed a whole tree — `local-tree` and `adopt` — get it from
`blocksEqual` via `withComparedBlocks`. `stampBumped` structure-shares, so
`result === input` is an exact "nothing was stamped" signal and a stamped tree
is no longer a second full copy. Revision and identity semantics are unchanged,
including that a no-op `update_text` still bumps `updated_at` (mirroring the
server's `UpdateText`, which does not compare text either).

**`components/EditableBlockTree.tsx`**: `focusInSubtree` (a subtree walk per
rendered row, per keystroke re-render) is replaced by one `ancestorChain` call
at the tree root, passed down as the `focusChain` set; each row's test is
`focusChain.has(node.uid)`.

**Tests**: 21 table-driven cases assert `applyOpsWithChange`'s flag equals the
`JSON.stringify` verdict it replaced; a field sweep fails if `blocksEqual` ever
misses a `BlockNode` field. `outlineState.test.ts` pins no-op transition
identity (remote op, rebuilt tree, same-millisecond stamp), plus two structural
assertions: zero `JSON.stringify` calls across three transitions, and at most
one pass over the previous tree per op transition (counted through a getter).
New `EditableBlockTree.focus.test.tsx` asserts `ancestorChain` runs once for a
12-row render, never for an unfocused tree, and that focus in one table subtree
leaves a sibling table rendered.

**Docs**: `docs/architecture/frontend.md` — the `applyOpsWithChange` verdict and
the two change-signal paths in the block-tree section; the root-computed focus
chain in the editor section.
