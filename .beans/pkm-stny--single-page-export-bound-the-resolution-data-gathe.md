---
# pkm-stny
title: 'Single-page export: bound the resolution-data gather'
status: completed
type: bug
priority: normal
created_at: 2026-10-24T15:54:36Z
updated_at: 2026-10-24T23:15:19Z
parent: pkm-mfd0
---

Follow-up from pkm-8bga review. routes_export._gather_resolution_data runs every distinct query expression found at depth 0 and 1, and execute_plan fetches all matching rows with no LIMIT: cost is Q x M rows held as QueryResultItems before the render budget (EXPORT_MAX_CHARS) is consulted. Q (distinct expressions, ~500 per 11 KB of stored text; string-distinct but equivalent expressions defeat visited_exprs) and M (up to the whole graph) are both page-shaped. Fix idea: stop gathering once the gathered item count passes max_chars / 5 (each rendered item costs at least five characters) and refuse with the same ExportTooLarge. Review: .superpowers/sdd/2026-10-24-page-export-size-cap/task-1-review.md Important 4 (gitignored, branch security/8bga worktree).

## Decision (Arthur, 2026-10-24)

See docs/superpowers/specs/2026-10-24-security-epic-decisions-design.md, row pkm-stny.

## Summary of Changes

- Single-page export charges the resolution-data gather against the export budget (GatherBudget) as it goes, using the renderer's own price for each piece (never more than rendering it once costs), and streams query rows instead of materialising every match; once the budget is spent it refuses with the same ExportTooLarge 422.
- A query macro found inside a result item is charged at least its expression's length (the renderer's floor); a query matching nothing skips its rows query.
- Measured: one query matching 1,000,000 blocks 12.3 s / 1066 MB -> 0.85 s / 98 MB; 200 equivalent queries x 20,000 matches 41.5 s / 1050 MB -> 1.3 s / 178 MB; pages under the budget export byte-identical.
- Accepted edge (documented): a query reached only through a ref inside another query macro is charged but never rendered, so such a page can be refused (adversarial fuzz: none of 2,500 random graphs refused outside that edge).
- Docs: backend.md export section states what is bounded (rows by the call budget, held ref text by the scan charge, ~100M characters); troubleshooting row.
- Ruling: bound = renderer's price rather than the bean's max_chars / 5 (tighter and never refuses what the renderer would render).
