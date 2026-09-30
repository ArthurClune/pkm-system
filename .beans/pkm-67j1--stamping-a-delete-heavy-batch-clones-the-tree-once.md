---
# pkm-67j1
title: Stamping a delete-heavy batch clones the tree once per delete
status: completed
type: task
priority: low
created_at: 2026-09-30T12:47:07Z
updated_at: 2026-09-30T13:39:05Z
parent: pkm-a4t2
---

`stampBaseTextHashes` (`web/src/outline/baseTextHash.ts`) re-applies each op with `applyOps` while a later op still needs a stamp, and `applyOps` clones and walks the whole tree each call. Since deletes are stamped (`base_subtree_hash`), a batch of N deletes clones the page N-1 times on the main thread. Measured in review with a scratch vitest bench: 11 ms for 100 deletes on a 3,000-node page, 281 ms for 1,000 deletes on 9,000 nodes. Triggers: multi-select delete (one delete per selection root), undo of a large paste (one delete per created block).

Fix: clone once at the start and apply each op in place (`applyOne`, or an exported in-place variant of `applyOps`). Every stamp is a string computed before its op applies, so results are identical.

- [x] Clone once, apply in place; existing stamping tests unchanged
- [x] A test or bench showing a delete-heavy batch no longer scales with deletes x page size
- [x] `perf/check.sh frontend`

## Summary of Changes

stampBaseTextHashes clones the page at most once per batch (lazily, only when an op before the last stamp must be applied) and applies each op to that clone in place. tree.ts exports cloneTree and applyOpInPlace (the former private clone/applyOne), so op semantics stay in one function. baseTextHash.clone.test.ts pins the clone count (once for 100 deletes, zero for a single stamp or none) and that the caller's blocks are untouched; the existing stamping tests are unchanged. Scratch bench: 9k nodes / 1,000 deletes went from ~158 ms to ~20 ms (the remaining cost is the per-op locate walks). perf/check.sh frontend: no changes (no scenario covers a bulk delete).
