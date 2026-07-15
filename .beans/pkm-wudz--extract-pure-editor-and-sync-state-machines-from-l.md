---
# pkm-wudz
title: Extract pure editor and sync state machines from large shells
status: todo
type: task
priority: normal
tags:
    - web
    - architecture
    - fcis
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Goal

Reduce complexity in EditableBlockTree, useOutline, SyncProvider, and opQueue by moving deterministic transition logic into Functional Core modules.

## Scope

Extract pure reducers/decision functions for editor events, outline reconciliation, queue transitions, and sync state transitions. Keep DOM, React, timers, network, worker, and persistence effects in thin shells.

## Acceptance criteria

- [ ] Pure transition APIs and effect descriptions are defined.
- [ ] useOutline edit construction, upload splicing, and remote-batch decisions move to core helpers where practical.
- [ ] Sync and queue transition rules are testable without React, fetch, workers, or SQLite mocks.
- [ ] EditableBlockTree keyboard policy is separated from DOM execution where practical.
- [ ] Runtime files have accurate FCIS classifications.
- [ ] Existing behavior and coverage thresholds are preserved.
- [ ] pnpm verify passes.
