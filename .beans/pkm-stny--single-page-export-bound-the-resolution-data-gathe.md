---
# pkm-stny
title: 'Single-page export: bound the resolution-data gather'
status: todo
type: bug
priority: low
created_at: 2026-10-24T15:54:36Z
updated_at: 2026-10-24T15:54:36Z
parent: pkm-mfd0
---

Follow-up from pkm-8bga review. routes_export._gather_resolution_data runs every distinct query expression found at depth 0 and 1, and execute_plan fetches all matching rows with no LIMIT: cost is Q x M rows held as QueryResultItems before the render budget (EXPORT_MAX_CHARS) is consulted. Q (distinct expressions, ~500 per 11 KB of stored text; string-distinct but equivalent expressions defeat visited_exprs) and M (up to the whole graph) are both page-shaped. Fix idea: stop gathering once the gathered item count passes max_chars / 5 (each rendered item costs at least five characters) and refuse with the same ExportTooLarge. Review: .superpowers/sdd/2026-10-24-page-export-size-cap/task-1-review.md Important 4 (gitignored, branch security/8bga worktree).
