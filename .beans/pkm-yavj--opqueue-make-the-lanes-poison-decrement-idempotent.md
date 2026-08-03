---
# pkm-yavj
title: 'opQueue: make the lane''s poison decrement idempotent per batch'
status: completed
type: bug
priority: low
created_at: 2026-07-31T20:18:43Z
updated_at: 2026-08-03T15:46:17Z
---

Follow-up from pkm-49eh's final review (branch pkm-6phf).

durableBatchSettled() runs before `await markPoisoned`. If the mark RPC throws, the row stays non-poisoned and an outside resume (SyncProvider legacy repair, replicaSync) lets nextBatch() hand it out again: the same batch takes the same 4xx and decrements durableAhead twice, leaving the lane head's count one too low — a retained op can then overtake a durable batch that genuinely precedes it. Needs durableAhead>=2 + a durable 4xx + a failing markPoisoned RPC + an outside resume; worst case is a bounded reorder, never loss.

Cheapest fix per review: decrement only when rememberPoisonMark records a genuinely new intent.

- [x] Regression test: failed mark + resume must not double-decrement
- [x] Key the decrement to new poison intents (or batch identity)

## Summary of Changes

`rememberPoisonMark` now returns whether it recorded a genuinely new intent
(`!retained.has(key)`, keyed by rowId + batchId as before), and the 4xx branch
in `runDrain` calls `durableBatchSettled()` only for that first rejection. A
repeat rejection of a row whose mark RPC failed therefore no longer decrements
the lane head a second time.

The retained-intent map is the right key because it is exactly the record that
survives the failing `markPoisoned` (a successful mark clears it, but a
successfully-marked row is never handed out by `nextBatch` again). Over-counting
remains self-correcting: `nextBatch` skips poisoned rows, so once the deliverable
rows drain, the observed-empty clamp zeroes every count.

Test: "a failed poison mark cannot decrement the lane twice for one batch" in
`web/src/sync/opQueue.replica.test.ts` — two durable rows ahead of a retained
op, the first row 4xx'd with a `markPoisoned` that throws once, then an outside
`resume()` re-delivers it for a second 4xx. Before the fix the retained op was
posted ahead of the second durable batch; now the POST order is
rejected, rejected, durable, retained.

`docs/architecture/sync-and-offline.md` now states that the lane count-down is
keyed to the batch, and why.
