---
# pkm-1jw6
title: Correct and enforce TypeScript FCIS boundaries
status: todo
type: task
priority: high
tags:
    - web
    - fcis
    - architecture
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-15T14:23:26Z
parent: pkm-c1cg
---

## Problem

Several files labelled Functional Core perform browser I/O, React state/context work, navigation, randomness, or message-port I/O. Core modules can also import Imperative Shell components.

## Scope

Audit runtime classifications, split pure decisions from behavioral wrappers where useful, and automate boundary enforcement.

## Acceptance criteria

- [ ] rpc.ts, uid.ts, contexts.ts, BlockRef, AssetImage, PageLink, TodoCheckbox, InlineSegments, and comparable files are correctly classified or split.
- [ ] Functional Core modules do not import Imperative Shell modules.
- [ ] Nondeterministic values such as UIDs are gathered in shells or passed into pure functions.
- [ ] A repository check enforces required pattern comments and core-to-shell import boundaries.
- [ ] Intentional exceptions are documented using the FCIS unavoidable format.
- [ ] The check runs in pnpm verify.
- [ ] pnpm verify passes.
