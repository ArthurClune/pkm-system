---
# pkm-x7a5
title: 'Server sync follow-ups: small tests + cleanups from pkm-dnl6 reviews'
status: completed
type: task
priority: low
created_at: 2026-07-12T18:45:48Z
updated_at: 2026-07-13T18:37:13Z
parent: pkm-y8p0
---

Deferred minors from pkm-dnl6 per-task + final reviews, batchable into any later server touch: (1) test for MAX_LIMIT clamp in /api/sync/changes; (2) spec-named subtree-move journal test (spec section 7); (3) sync_core.py import Sequence from collections.abc not typing; (4) typed WS seq frame (notify._seq_frame) + unify 409/400 detail shapes — both part of the spec's contract-hardening item; (5) applied_batches IntegrityError race branch remains untested (two-connection interleave; traced sound in review).

## Summary of Changes

All five items closed on branch codex/pkm-offline-web:
1. MAX_LIMIT clamp test (real >5000-row journal; next_since < latest_seq) plus a limit=0 progress test.
2. Spec-named cross-page subtree-move journal test (uid_b2+uid_b3 both journaled with new page_id).
3. sync_core.py imports Sequence from collections.abc.
4. Typed WS seq frame: notify.SeqFrame pydantic model + public seq_frame(); /api/ops 409 detail unified to the 400 shape {index: None, reason}.
5. applied_batches IntegrityError race branch covered: monkeypatched apply_batch commits the winner on a second connection first; loser rolls back its effects and serves the stored ack.
