---
# pkm-yavj
title: 'opQueue: make the lane''s poison decrement idempotent per batch'
status: todo
type: bug
priority: low
created_at: 2026-07-31T20:18:43Z
updated_at: 2026-07-31T20:18:43Z
---

Follow-up from pkm-49eh's final review (branch pkm-6phf).

durableBatchSettled() runs before `await markPoisoned`. If the mark RPC throws, the row stays non-poisoned and an outside resume (SyncProvider legacy repair, replicaSync) lets nextBatch() hand it out again: the same batch takes the same 4xx and decrements durableAhead twice, leaving the lane head's count one too low — a retained op can then overtake a durable batch that genuinely precedes it. Needs durableAhead>=2 + a durable 4xx + a failing markPoisoned RPC + an outside resume; worst case is a bounded reorder, never loss.

Cheapest fix per review: decrement only when rememberPoisonMark records a genuinely new intent.

- [ ] Regression test: failed mark + resume must not double-decrement
- [ ] Key the decrement to new poison intents (or batch identity)
