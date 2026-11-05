---
# pkm-t44u
title: Assistant can read pages too big for one tool result
status: in-progress
type: feature
priority: normal
created_at: 2026-11-05T12:56:56Z
updated_at: 2026-11-05T13:02:08Z
---

The in-app assistant's get_page on a large page (Rugit, 58k chars) hits Claude Code's MCP output cap (MAX_MCP_OUTPUT_TOKENS, default 25,000 tokens), which saves the result to a file the assistant has no tool to read. Raise the assistant's cap to 40,000 tokens and make get_page/get_block return an outline with uids and sizes when the rendered result is over a size limit, so the model fetches the part it needs with get_block. Design: docs/superpowers/specs/2026-11-05-mcp-page-outline-design.md


## Checklist
- [ ] Bounded renderers in pkm/render.py (outline over budget)
- [ ] MCP get_page/get_block use the budget; pkm-mcp --max-chars
- [ ] Assistant: MAX_MCP_OUTPUT_TOKENS=40000, --max-chars 75000
- [ ] Docs: cli-and-mcp.md, assistant.md
- [ ] Live read-only check against production pages
- [ ] perf/check.sh backend

Plan: docs/superpowers/plans/2026-11-05-mcp-page-outline.md
