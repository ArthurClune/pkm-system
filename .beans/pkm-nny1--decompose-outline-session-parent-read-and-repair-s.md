---
# pkm-nny1
title: Decompose outline session parent-read and repair state machines
status: todo
type: task
priority: low
tags:
    - review
    - frontend
created_at: 2026-08-17T20:55:24Z
updated_at: 2026-08-17T20:55:24Z
parent: pkm-wvvu
---

## Review findings

Frontend `outline/outlineSessions.ts` complexity finding. Registry/refcount/lease ownership, parent-read election, and repair epochs are independently coherent machines currently colocated in an 882-line module.

## Acceptance criteria

- [ ] Extract parent-read election behind a focused interface with isolated tests
- [ ] Extract repair-epoch state and transitions behind a focused interface with isolated tests
- [ ] Leave registry/refcount/lease ownership readable in the remaining session module
- [ ] Preserve ReadToken supersession, manual-read abandonment, parent waiter publication, reservation semantics, and repair ordering
- [ ] Avoid changing public session behavior solely to make extraction easier
- [ ] Update frontend and sync architecture documentation and run focused race suites plus full web verification
