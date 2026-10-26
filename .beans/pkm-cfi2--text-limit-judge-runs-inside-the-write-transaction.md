---
# pkm-cfi2
title: Text-limit judge runs inside the write transaction
status: completed
type: task
priority: low
created_at: 2026-10-25T02:14:32Z
updated_at: 2026-10-26T20:23:11Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf Task 3 review (2026-10-25). find_op_text_limit_violation runs inside begin_immediate, so a 500-op worst-case batch (1M-char texts, deep nests) can hold the single writer ~100 s. Judge op texts before taking the write lock (they don't depend on DB state).

- [x] Move the judge before begin_immediate; measure
- [x] Test that a refused batch never takes the lock

## Summary of Changes

- Behaviour: `judge_batch` (ops_core) runs the text-limit and title judges off the event loop (threadpool) before the write lock; `apply_batch` takes a `JudgedBatch` so the order is type-enforced. A refused batch never waits for or takes the lock (tests with a second connection holding BEGIN IMMEDIATE: refused 400 instead of 503). Reasons and order (limits before titles) are unchanged.
- Commit: 027f2662; fix round 3d852e18 and b4b29b69.
- Ruling (orchestrator): the judge refuses first, but a retried already-applied batch must answer its stored ack, never 400 after a deploy tightens a limit, so the batch id is looked up without the write lock before refusing (cost: one extra read on refused batches). Note: 6fcv's expect check stays after the dedupe inside BEGIN IMMEDIATE when merged. Later work moved the replay bound under the lock to a charged budget (see pkm-6jyz).
- Follow-ups: pkm-8w77 (apply_batch still runs on the event loop), pkm-7981.
