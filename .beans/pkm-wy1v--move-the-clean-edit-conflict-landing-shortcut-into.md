---
# pkm-wy1v
title: Move the clean-edit conflict-landing shortcut into a pure ops_core predicate
status: todo
type: task
created_at: 2026-09-28T21:01:10Z
updated_at: 2026-09-28T21:01:10Z
---

Found in the pkm-3g4n reviews. ops_apply._context_for skips the daily-page/header context for a live block when no block_rewrites exist and text_hash(current_text) == base_text_hash. That duplicates check 4's hash comparison in the shell, a small FCIS leak. It also misses two clean cases that still create today's daily page and cost about 3 queries: (a) blocks with block_rewrites in the 30-day window, which after a rename means every block referencing the renamed page; (b) a stale hash with identical text (check 2). Fix: a pure ops_core predicate that runs replay_title_rewrites and reports whether check 5 would be reached; the shell calls it. Also drop the conflict_uid requirement from plan_op's check-5 preamble on clean applies, and stop minting a header uid when today's header already exists.
