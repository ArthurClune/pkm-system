---
# pkm-b2wb
title: Consolidate backend review minor cleanups and concurrency documentation
status: todo
type: task
priority: low
tags:
    - review
    - backend
created_at: 2026-08-17T20:55:22Z
updated_at: 2026-08-17T20:55:22Z
parent: pkm-wvvu
---

## Review findings

Backend minor duplication, B4 marginal, and the describe-service comment imbalance not absorbed by the larger children.

## Acceptance criteria

- [ ] Share the describe enqueue eligibility/active/add/queue ritual between single enqueue and scan
- [ ] Document describe shutdown semantics: idempotent close and caller cancellation must not abort worker teardown
- [ ] Explain that `assistant.policy.all_tool_names()` is a contract-tripwire test subject if it intentionally remains production-unused
- [ ] Reassess the duplicated `_BLOCK_COLS` constant and leave it duplicated only with its deliberate-coupling rationale intact
- [ ] Remove any remaining tiny duplicate or dead helper identified by the review only where the replacement is clearer
- [ ] Add focused tests for behavior-changing cleanup and run backend lint/type/coverage gates
