---
# pkm-v0vw
title: Rewrite rows re-read on every op that records rows
status: todo
type: bug
priority: low
created_at: 2026-10-26T13:57:15Z
updated_at: 2026-10-26T13:57:15Z
parent: pkm-mfd0
---

Found in the security/batch-server Task 13 re-review (concern 1). The per-batch cache of a block's rewrite rows (_block_rewrites/_rewrite_steps in the ops apply loop) is dropped on each RecordRewrite, so every op that records rows re-reads all the block's rows: about 1.1 ms per MB of rows per op (20 rows of 1M copies, 100 chained edits: 2.2 s). Bounded by the 30-day retention and the attacker paying in DB growth; older than the branch.

Fix: prepend the recorded rows to the cached tuple instead of dropping it, so rows are read once per block per batch.

- [ ] Failing test counting row reads across a batch of recording ops
- [ ] Keep the cache across RecordRewrite
- [ ] troubleshooting.md row
