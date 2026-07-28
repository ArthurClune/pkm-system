---
# pkm-tu3a
title: Preserve block hierarchy when pasting outlines
status: completed
type: feature
priority: normal
created_at: 2026-07-21T14:11:36Z
updated_at: 2026-07-27T21:22:54Z
---

When pasted text contains outline indentation, parse it into a temporary forest and create blocks whose parent relationships preserve the clipboard's relative hierarchy. Anchor the resulting forest at the paste location.

## Relationship

Related to pkm-0ovd, which adds atomic one-level indentation for existing multi-block selections. This paste feature should use a separate pure clipboard-to-create-ops planner rather than requiring a generic existing-tree depth/diff engine. It may reuse small tree/ordering helpers established by pkm-0ovd, but is not blocked on a generic transform abstraction.

## Checklist

- [x] Brainstorm clipboard formats and indentation rules
- [x] Design a pure clipboard forest parser and create-op planner
- [x] Implement with unit tests for nested and malformed indentation
- [x] Add integration and end-to-end paste coverage
- [x] Run full verification

## Summary of Changes

- New Functional Core module `web/src/outline/paste.ts`: `parseOutlineForest`
  turns clipboard text into a forest with an indent stack (tabs/2-space/
  4-space all work ordinally; over-indent jumps clamp to one level; blank
  lines drop; `- `/`* `/`+ ` bullets strip only when every line has one);
  `planOutlinePaste` anchors the forest at the caret — first root splices
  into the target block at [selStart, selEnd), its children become the
  target's first children (expanding a collapsed target), remaining roots
  become following siblings, all as one op batch with focus on the last
  created block.
- `selectionText` (blockSelection.ts) now emits one tab per depth level
  relative to the shallowest selected block, so multi-block copy → paste
  round-trips hierarchy.
- Shell wiring: `OutlineHandlers.onPasteOutline` dispatched from
  `BlockInput.onPaste` (files first, single-line pastes stay native) and run
  through `useOutline`'s `run()` pipeline — one optimistic, synced, undoable
  batch.
- Tests: 24 parser/planner unit cases, copy-indentation cases, component
  paste-routing tests, `useOutline.paste` hook tests, and a new
  `web/e2e/paste.spec.ts` (paste hierarchy + copy round-trip, asserted in
  both DOM and server structure).
- Design and plan: `docs/superpowers/specs/2026-07-27-pkm-tu3a-outline-paste-design.md`,
  `docs/superpowers/plans/2026-07-27-pkm-tu3a-outline-paste.md`.
- Verified: `web pnpm verify` green (40 e2e), server 754 passed / 95.76%
  coverage, pyrefly and ruff clean.

### Known round-trip edges (accepted)

- Blocks that all begin with `- ` (or `* `/`+ `) lose the marker on paste —
  bullet stripping treats a consistent markdown list as structural, not
  content.
- A block whose own text begins with tabs or spaces re-nests on paste — the
  parser can't distinguish "this is indentation" from "this text happens to
  start with whitespace."
- A block containing a literal newline splits into multiple blocks on
  paste — the parser has no way to represent an embedded newline within one
  node.
- A single content line (even with a trailing newline) is never
  intercepted; it takes the native textarea splice rather than a
  tree-direct update, so it can't fight `BlockInput`'s dirty-draft
  adoption (pkm-tu3a final-review finding).

## Reverted 2026-07-27

Reverted on main the same evening it shipped (revert of merge adf8c80):
after live use, Arthur found that splitting multi-line NON-indented text
into multiple blocks is not clearly an improvement (e.g. pasting prose or
text destined for a single block). The implementation remains in history
(branch commits 3a4f344..040f34c, merge adf8c80) for reuse. Rework tracked
in a follow-up bean: paste UX to be decided by experimentation — ideas
include only intercepting indented/structured clipboards and a
Shift-Cmd-V "paste into single block" escape hatch.
