---
# pkm-cfi2
title: Text-limit judge runs inside the write transaction
status: todo
type: task
priority: low
created_at: 2026-10-25T02:14:32Z
updated_at: 2026-10-25T02:14:32Z
parent: pkm-mfd0
---

From the pkm-gc3n/bppf Task 3 review (2026-10-25). find_op_text_limit_violation runs inside begin_immediate, so a 500-op worst-case batch (1M-char texts, deep nests) can hold the single writer ~100 s. Judge op texts before taking the write lock (they don't depend on DB state).

- [ ] Move the judge before begin_immediate; measure
- [ ] Test that a refused batch never takes the lock
