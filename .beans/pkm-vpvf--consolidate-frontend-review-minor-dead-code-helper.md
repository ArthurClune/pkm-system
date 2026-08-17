---
# pkm-vpvf
title: Consolidate frontend review minor dead code helpers and constants
status: todo
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:25Z
updated_at: 2026-08-17T20:55:25Z
parent: pkm-wvvu
---

## Review findings

Frontend B4, small A6 twins, and correctness-adjacent documentation/constants not absorbed by larger children.

## Acceptance criteria

- [ ] Delete dead local API re-exports and the unused repair epoch id/counter
- [ ] Decide whether test-only `moveBlockUp`, `moveBlockDown`, and `createSyncState` belong in production exports; narrow or document them
- [ ] Share `scopeContainsTitle` and simplify repeated sync reset precedence/base construction where doing so improves clarity
- [ ] Add a chord predicate for repeated modifier policy in `decideEditorKey` without table-driving the priority chain
- [ ] Document the distinct worker data-stamp and deadline clocks, and replace bare recovery timeout literals with the named constant where semantically identical
- [ ] Make `onDragStartBlock` optional or move its real ownership so the base stub/spread override is unnecessary
- [ ] Add focused tests for behavior changes and run type, lint, FCIS, and unit gates
