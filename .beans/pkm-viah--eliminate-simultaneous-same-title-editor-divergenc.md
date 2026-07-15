---
# pkm-viah
title: Eliminate simultaneous same-title editor divergence
status: todo
type: bug
priority: high
tags:
    - web
    - outline
    - dnd
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Problem

Two same-title EditablePage instances mounted in one commit both observe no active owner and become editable. Their local state can diverge and the DnD registry is last-wins.

## Scope

Provide shared per-title outline state or atomic subscription-backed editor ownership, and make duplicate DnD registration safe.

## Acceptance criteria

- [ ] Simultaneous same-title mounts cannot create independent editable states.
- [ ] All views of one title observe the same local edits, or exactly one is atomically read-only.
- [ ] DnD registration rejects duplicates or restores the prior owner safely.
- [ ] The existing test that documents double ownership is replaced with the intended behavior.
- [ ] Sequential sidebar/main-pane behavior remains covered.
- [ ] pnpm verify passes.
