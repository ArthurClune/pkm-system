---
# pkm-67j1
title: Stamping a delete-heavy batch clones the tree once per delete
status: todo
type: task
priority: low
created_at: 2026-09-30T12:47:07Z
updated_at: 2026-09-30T12:47:07Z
parent: pkm-a4t2
---

`stampBaseTextHashes` (`web/src/outline/baseTextHash.ts`) re-applies each op with `applyOps` while a later op still needs a stamp, and `applyOps` clones and walks the whole tree each call. Since deletes are stamped (`base_subtree_hash`), a batch of N deletes clones the page N-1 times on the main thread. Measured in review with a scratch vitest bench: 11 ms for 100 deletes on a 3,000-node page, 281 ms for 1,000 deletes on 9,000 nodes. Triggers: multi-select delete (one delete per selection root), undo of a large paste (one delete per created block).

Fix: clone once at the start and apply each op in place (`applyOne`, or an exported in-place variant of `applyOps`). Every stamp is a string computed before its op applies, so results are identical.

- [ ] Clone once, apply in place; existing stamping tests unchanged
- [ ] A test or bench showing a delete-heavy batch no longer scales with deletes x page size
- [ ] `perf/check.sh frontend`
