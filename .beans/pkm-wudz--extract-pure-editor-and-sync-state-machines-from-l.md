---
# pkm-wudz
title: Extract pure editor and sync state machines from large shells
status: completed
type: task
priority: normal
tags:
    - web
    - architecture
    - fcis
created_at: 2026-07-15T14:23:26Z
updated_at: 2026-07-16T08:08:13Z
parent: pkm-c1cg
---

## Goal

Reduce complexity in EditableBlockTree, useOutline, SyncProvider, and opQueue by moving deterministic transition logic into Functional Core modules.

## Scope

Extract pure reducers/decision functions for editor events, outline reconciliation, queue transitions, and sync state transitions. Keep DOM, React, timers, network, worker, and persistence effects in thin shells.

## Acceptance criteria

- [x] Pure transition APIs and effect descriptions are defined.
- [x] useOutline edit construction, upload splicing, and remote-batch decisions move to core helpers where practical.
- [x] Sync and queue transition rules are testable without React, fetch, workers, or SQLite mocks.
- [x] EditableBlockTree keyboard policy is separated from DOM execution where practical.
- [x] Runtime files have accurate FCIS classifications.
- [x] Existing behavior and coverage thresholds are preserved.
- [ ] pnpm verify passes.

## Summary of Changes

New Functional Core modules (each `// pattern: Functional Core`, no React/DOM/
IO, exhaustive switches with `never` asserts, pure tests with no mocks):

- `outline/keyboardPolicy.ts` — `decideEditorKey(EditorKeyInput): KeyDecision`.
  The focused-block keydown policy (autocomplete precedence, Escape/blur,
  Ctrl-O ref nav, Shift+Arrow block-selection, read-only cutoff, heading chord,
  Cmd-K, bracket auto-pair, split/indent/move/backspace, boundary arrows,
  browser-default). `EditableBlockTree.BlockInput.onKeyDown` now reads the live
  DOM + autocomplete state and executes the returned decision.
- `outline/outlineState.ts` — added `pendingTextOps(pending, blocks)` (the
  debounced-draft flush decision) and `spliceUploadedMarkdown(text, offset,
  markdown)` (clamped asset splice). `useOutline.takePendingTextOps` and
  `onFiles` now call these.
- `sync/queueState.ts` — `transitionQueue(QueueState, QueueEvent): QueueTransition`
  plus `terminalReason` selector. The shared connectivity + retry-backoff
  policy (online/pause/resume/dispose, escalating retry, terminal-reason
  classification). Both `createReplicaQueue` and `createLegacyQueue` in
  `opQueue.ts` dispatch into it; the shells keep the timer handle, promises,
  deliveries, and persistence.
- `sync/syncState.ts` — `transitionSync(SyncState, SyncEvent): SyncTransition`
  plus `computeEditability` selector. The delivery-health problem lifecycle
  (rejected-batch repair phases, legacy repair, poison discovery), the
  mode-ready resync decision, and the editability rule. `SyncProvider` routes
  every `setProblem`/mode-ready resync through it via an `applySync` helper and
  derives `canEdit`/`readOnlyReason` from the selector; it keeps all sockets,
  queue/replica I/O, refs, single-flight, and mounted guards.

`SyncProblem`/`SyncStatus` types moved to `syncState.ts` (re-exported from
`SyncProvider` for compatibility). `replicaSync.ts` was left as a shell: its
recovery ordering is control flow around lease/snapshot I/O with no
deterministic sub-policy separable from the queue/sync cores.
