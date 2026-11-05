---
# pkm-erii
title: MCP list tools stay under Claude Code's result size
status: in-progress
type: feature
priority: normal
created_at: 2026-11-05T16:31:27Z
updated_at: 2026-11-05T16:32:34Z
---

backlinks, query and changed_blocks (and todos as it grows) can return more than Claude Code's 50,000-character MCP result threshold on hub pages (backlinks Paper 95k, query [[Paper]] 99k, [[Meeting]] 63k, changed since 2026-10-01 64k); the harness then saves the result to a file the in-app assistant cannot open. Register every read tool as plain text with the declared result size get_page uses, and bound the list tools to the --max-chars budget with an explicit partial-list note and a hint on how to narrow. Follows pkm-t44u.


## Checklist
- [x] Bounded list renderers (render.py)
- [x] Read set registered plain text with declared size; list tools use the budget
- [x] Docs (cli-and-mcp.md, troubleshooting row)
- [x] Harness check through the bundled CLI
- [x] perf/check.sh backend

Spec: docs/superpowers/specs/2026-11-05-mcp-list-budget-design.md
Plan: docs/superpowers/plans/2026-11-05-mcp-list-budget.md
