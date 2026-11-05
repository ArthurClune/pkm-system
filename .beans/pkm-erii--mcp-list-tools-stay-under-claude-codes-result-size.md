---
# pkm-erii
title: MCP list tools stay under Claude Code's result size
status: completed
type: feature
priority: normal
created_at: 2026-11-05T16:31:27Z
updated_at: 2026-11-05T17:32:34Z
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


## Summary of Changes
- `render_groups_bounded`, `render_changed_bounded` and `render_backlinks_bounded` (pkm/render.py) return the unchanged render when it fits. Otherwise they return whole items in order up to the budget, each line clipped like an outline line and ending `^uid`, under a `(Partial list: ...)` note. The note gives exact counts, a per-tool narrowing hint, and says that get_block(uid) reads a clipped line. For changed_blocks it reads `of N+ pages` when the route's limit was hit.
- pkm-mcp: `READ_TOOL_NAMES` is pinned equal to the assistant's READ_TOOLS. Every read tool is registered as plain text with the declared result size. query, backlinks, todos and changed_blocks are cut at `--max-chars`.
- Verified through the bundled Claude Code against a fake API on production data. backlinks Paper and query [[Paper]] come back as partial lists (about 74.9k characters); query [[Meeting]] and changed_blocks since 2026-10-01 come back whole. All results are plain text and none is persisted.
- Docs: cli-and-mcp.md, assistant.md, troubleshooting row. Perf: one unrelated unstable scenario, filed as pkm-369f.
