---
# pkm-v0vw
title: Rewrite rows re-read on every op that records rows
status: completed
type: bug
priority: low
created_at: 2026-10-26T13:57:15Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

Found in the security/batch-server Task 13 re-review (concern 1). The per-batch cache of a block's rewrite rows (_block_rewrites/_rewrite_steps in the ops apply loop) is dropped on each RecordRewrite, so every op that records rows re-reads all the block's rows: about 1.1 ms per MB of rows per op (20 rows of 1M copies, 100 chained edits: 2.2 s). Bounded by the 30-day retention and the attacker paying in DB growth; older than the branch.

Fix: prepend the recorded rows to the cached tuple instead of dropping it, so rows are read once per block per batch.

- [x] Failing test counting row reads across a batch of recording ops
- [x] Keep the cache across RecordRewrite
- [x] troubleshooting.md row

## Summary of Changes

- Folded into pkm-6jyz's final fix: the per-batch cache of a block's rewrite rows is kept across RecordRewrite, and the final round (42b037b3) replaced whole-block reads with lazy reads per (uid, base_hash) via idx_block_rewrites_uid, charged to the batch budget, with identical duplicate rows skipped (900k-row tiny edit 2.58 s -> 0.00 s; duplicate post stays at 1,000 rows). The whole-block row-count test became the budget and dedupe tests. The failing-test and cache items map to those commits; the troubleshooting row is the one on a stale edit linking many deleted pages (every later small edit holding the lock).
- Commits: eba1f8f2, 793d45f9, 42b037b3, 6763fe3c. Ruling: orchestrator folded this bean into C1's fix; Arthur 2026-10-26 ruled the cache stays and rows are read lazily and charged. Status left for the orchestrator (the bean is a duplicate of pkm-6jyz's last item).
