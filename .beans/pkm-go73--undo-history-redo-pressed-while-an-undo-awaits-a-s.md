---
# pkm-go73
title: Undo replay to a page that mounts during its page read skips applyLocal
status: in-progress
type: bug
priority: normal
created_at: 2026-10-25T12:48:05Z
updated_at: 2026-11-11T13:53:50Z
---

## Symptom

An undo or redo that queues behind a slow page read can land on a page whose
outline mounts while the read is in flight. The mounted tree then shows the
pre-undo text until the write is delivered (offline: until reconnect).

## Cause

`web/src/outline/undoManager.ts`: `dispatch` peeks for the page's outline
session once, finds none, and awaits `dispatchUnmounted`. That awaits
`loadPage` and then checks only `stale()`. If an earlier step's `settle()`
navigated to the page, React mounts its session during the read, so the
replay is enqueued without `handle.applyLocal`.

## Fix

- [x] Red unit test: a session mounts while `dispatchUnmounted` awaits the read; the replay must reach that session's tree
- [x] After the await, peek the session again; if one exists, go through `dispatchWithSession` (re-planning against the session's tree, not the read)
- [ ] `proptest/check.sh web` (undo history) before merge

## Out of scope (ruled 2026-11-11)

A redo pressed while an undo awaits a slow read, followed by a refused undo,
duplicates the entry on a stack (and the mirror case). It needs a rare
three-way race and loses no data. Revisit only if seen.
