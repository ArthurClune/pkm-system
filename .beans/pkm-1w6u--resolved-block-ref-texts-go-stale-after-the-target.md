---
# pkm-1w6u
title: Resolved block-ref texts go stale after the target block is edited
status: todo
type: bug
priority: deferred
created_at: 2026-08-28T17:23:08Z
updated_at: 2026-08-28T17:23:08Z
---

Found while investigating pkm-0one. Not user-reported as a problem — Arthur hasn't noticed it in practice and is probably OK with the behaviour; recorded so the mechanism is on file if it ever bites.

## Symptom

A rendered ((uid)) block ref keeps showing the target block's text as it was when it was resolved. If the referenced block is edited afterwards, every surface currently showing the ref (page, journal, sidebar, assistant) keeps the stale text until that surface remounts. Affects the main pane as much as the sidebar.

## Root cause

`web/src/components/BlockRefProvider.tsx` has no invalidation:
- The page-load seed (`payload.block_ref_texts`) always wins the merge (line 44: `{...fetched, ...seed}`).
- On-demand fetches are deduped per mount (`requestedRef`, line 25) — each uid is fetched at most once.
- Nothing subscribes to block updates, so neither layer is ever refreshed.

## Fix shape (two halves, different cost)

- [ ] Cross-client edits (small): subscribe BlockRefProvider to `SyncContext.subscribe` (applied remote `WsBatch`es); for `UpdateTextOp`/`DeleteOp` uids present in the value map, patch an `overrides` layer that wins over the seed and clear the fetch-dedupe entry. ~30-40 lines + unit tests.
- [ ] Same-client edits (medium, needs design): own echoes are filtered before subscribers (`sync/SyncProvider.tsx:506`), so an edit in the main pane never reaches a sidebar showing the ref. Needs a new invalidation channel — either deliver own batches to subscribers with an "own" flag, or emit uid→text updates from the editor commit path. Delicate area (see pkm-z77x history on refetches clobbering newer state); brainstorm/plan before implementing.
