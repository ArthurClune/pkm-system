---
# pkm-go73
title: Undo replay to a page that mounts during its page read skips applyLocal
status: completed
type: bug
priority: normal
created_at: 2026-10-25T12:48:05Z
updated_at: 2026-11-11T14:31:44Z
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
- [x] `proptest/check.sh web` (undo history) before merge

## Out of scope (ruled 2026-11-11)

A redo pressed while an undo awaits a slow read, followed by a refused undo,
duplicates the entry on a stack (and the mirror case). It needs a rare
three-way race and loses no data. Revisit only if seen.

## Summary of Changes

Symptom: after an undo or redo that waited behind a slow page read, the page's outline showed the pre-undo text until the write was delivered (offline: until reconnect), though the undo had been sent.

Cause: dispatchUnmounted in web/src/outline/undoManager.ts peeked for the page's outline session only before the read. When an earlier step's settle() navigated to the page, its session mounted during the read, and the replay was enqueued without handle.applyLocal, planned against the read instead of the mounted tree.

Fix: after the read, whether it succeeds or fails, dispatchUnmounted peeks again and, when a session exists, goes through dispatchWithSession: it re-plans against the session's tree, applies locally and releases the handle. The unstamped warning now fires only when the batch really ships unstamped. Rule stated in docs/architecture/frontend-editor.md, the editor rules table's history-replay row. Tests: undoManager.test.ts "an outline that mounts while the page read succeeds|fails gets the replay". proptest/check.sh web and pnpm test:coverage green.
