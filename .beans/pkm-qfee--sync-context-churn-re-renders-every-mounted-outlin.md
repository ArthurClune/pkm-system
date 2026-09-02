---
# pkm-qfee
title: Sync context churn re-renders every mounted outline; no React.memo anywhere
status: todo
type: task
priority: normal
created_at: 2026-09-01T21:28:06Z
updated_at: 2026-09-01T21:28:06Z
parent: pkm-fgjg
---

Tier 2 — cheap per tick, multiplied by the number of mounted Journal days (unmeasured with 30 days loaded; measured near-zero DOM effect on a single page because React reconciles to no-op).

## Findings (confirmed from code)
- `web/src/sync/SyncProvider.tsx:644-645` — the `Sync` context value memo depends on `pending`, `unsentInMemory`, `status`, `problem`… `emitPending()` (`opQueue.ts:214-217`) fires on every enqueue/ack/failure (call sites `:351, :380, :388, :528, :627, :696`), so a single flushed edit yields at least two new context identities (0→1→0).
- `web/src/outline/useOutline.ts:64` — `useSync()` per mounted outline (one per Journal day); `sync` is in the deps of `run` (`:200`), `handlers` (`:434`), `dnd` (`:451`), so all three get new identities.
- `web/src/dnd/DndContext.tsx:47` — DnD context value churns in lockstep.
- `web/src/views/EditablePage.tsx:52-64` — `handlers` is a fresh object literal every render, defeating any downstream memo.
- `web/src/components/EditableBlockTree.tsx:272-410` — `EditableBlock` recurses unmemoised. `grep -rn 'React.memo\|memo(' web/src` (non-test): zero hits.
- Journal mounts one `EditablePage` per loaded day and never unmounts (`views/Journal.tsx:217`).

## Ideas
- Split the volatile counters/status out of `SyncContext` into a small separate context (consumers: `OfflineIndicator`, unload guard) or expose via `useSyncExternalStore`; keep enqueue/subscribe/settled in a value stable for the provider's lifetime.
- `emitPending` bails when unchanged.
- Stabilise `EditablePage.handlers` (`useMemo`) and wrap `EditableBlock` in `React.memo`. Only consumers of *status* should re-render on a flap.

## Verify
React Profiler with ~30 Journal days loaded: type in one block, count commits and components rendered per flush. Add the measurement to `perf.mjs` (commit count via profiler hook or `__REACT_DEVTOOLS_GLOBAL_HOOK__`).

## Checklist
- [x] Baseline profile (Journal, 31 days mounted) — perf.mjs scenario J, `baselines/2026-09-02-qfee/before.json`
- [x] Context split (actions / resyncSeq / editability / health) + emitPending bail-out
- [x] handlers stable, EditableBlock memoised (plus the row props the tree used to rebuild per render: `selected`, `focusChain`, the upload/menu callbacks, `nowMs`)
- [x] Re-profile: 94.4 -> 3.4 re-rendered fibers per keystroke, worst commit 2278 -> 32 (`baselines/2026-09-02-qfee/report.md`); frontend.md state-management section now tables the four hooks
- [x] Review fixes: `pending` has one publisher (the queue) — suppressing an unchanged re-emit is only sound while the cache is what subscribers hold, and SyncProvider had a second writer; whole-value `useSync()` deleted (no app consumer)

## Not done here
- `applyOps` deep-clones the block tree, so every node object is new on an edit and `React.memo` cannot spare the edited day's own rows (~300 on a 300-row page). Structural sharing in `outline/tree.ts` would fix it; separate change.
- A durable count read issued before a concurrent enqueue is still accepted when it answers after it, so the count can be momentarily low. It self-heals on the next durable operation (the replica returns the authoritative row count) and no longer desyncs the emit cache. A proper guard needs a write-generation counter on `countPending`.
