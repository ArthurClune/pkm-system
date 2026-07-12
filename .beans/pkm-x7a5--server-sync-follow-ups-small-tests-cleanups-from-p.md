---
# pkm-x7a5
title: 'Server sync follow-ups: small tests + cleanups from pkm-dnl6 reviews'
status: todo
type: task
priority: low
created_at: 2026-07-12T18:45:48Z
updated_at: 2026-07-12T18:45:48Z
parent: pkm-y8p0
---

Deferred minors from pkm-dnl6 per-task + final reviews, batchable into any later server touch: (1) test for MAX_LIMIT clamp in /api/sync/changes; (2) spec-named subtree-move journal test (spec section 7); (3) sync_core.py import Sequence from collections.abc not typing; (4) typed WS seq frame (notify._seq_frame) + unify 409/400 detail shapes — both part of the spec's contract-hardening item; (5) applied_batches IntegrityError race branch remains untested (two-connection interleave; traced sound in review).
