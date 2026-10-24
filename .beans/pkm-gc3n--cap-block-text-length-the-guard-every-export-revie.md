---
# pkm-gc3n
title: Cap block text length (the guard every export review hit)
status: todo
type: task
priority: low
created_at: 2026-10-24T17:12:46Z
updated_at: 2026-10-24T19:02:24Z
parent: pkm-mfd0
---

From pkm-8bga's reviews. No block-text length cap exists, so the per-call transient memory in pkm.export.resolve.resolve_text scales with the largest stored block: one text of unresolvable refs ('((abcdefg))' * 500k) peaks at ~37 B/char while scanned (Match objects + event tuples), '{{query:}}' * 500k at ~30 B/char; a 10 MB block is ~370 MB transient, outside the export budget. A write-time cap (ops, importer, CLI) would bound this and the remaining 'W unbounded' cases. Needs Arthur's call on the cap and on what happens to existing over-cap rows (check prod copy for the largest block first). Review: .superpowers/sdd/2026-10-24-page-export-size-cap/task-1-rereview-4.md (gitignored, security/8bga worktree).

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-gc3n.
