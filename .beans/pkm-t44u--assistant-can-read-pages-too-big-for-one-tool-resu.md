---
# pkm-t44u
title: Assistant can read pages too big for one tool result
status: completed
type: feature
priority: normal
created_at: 2026-11-05T12:56:56Z
updated_at: 2026-11-05T15:24:10Z
---

The in-app assistant's get_page on a large page (Rugit, 58k chars) hits Claude Code's MCP output cap (MAX_MCP_OUTPUT_TOKENS, default 25,000 tokens), which saves the result to a file the assistant has no tool to read. Raise the assistant's cap to 40,000 tokens and make get_page/get_block return an outline with uids and sizes when the rendered result is over a size limit, so the model fetches the part it needs with get_block. Design: docs/superpowers/specs/2026-11-05-mcp-page-outline-design.md


## Checklist
- [x] Bounded renderers in pkm/render.py (outline over budget)
- [x] MCP get_page/get_block use the budget; pkm-mcp --max-chars
- [x] Assistant: MAX_MCP_OUTPUT_TOKENS=40000, --max-chars 75000
- [x] Docs: cli-and-mcp.md, assistant.md
- [x] Live read-only check against production pages
- [x] perf/check.sh backend

Plan: docs/superpowers/plans/2026-11-05-mcp-page-outline.md


## Summary of Changes
- `render_page_bounded`/`render_block_bounded` (pkm/render.py): the full uid render when it fits a character budget; otherwise the deepest whole-level outline that fits, with uids, `(N chars)` sizes and marked clipping. A get_block outline shows the root's own text in full. A block whose own text is over budget, or a page whose top-level outline is, gets an explicit RenderError.
- pkm-mcp: get_page/get_block use the budget (`--max-chars`, default 45,000, at most `MAX_RESULT_CHARS` 100,000). They are registered with `structured_output=False` and `_meta["anthropic/maxResultSizeChars"]`, so Claude Code neither JSON-wraps their text nor persists it to a file under its default 50,000-character threshold.
- Assistant harness: `MAX_MCP_OUTPUT_TOKENS=40000` and `--max-chars 75000`. Verified through the bundled Claude Code 2.1.301 against a fake API with the real pkm-mcp reading production: Rugit, LLM/Prompt Engineering and UoS/VP Research Strategy Group arrive whole. Before the fix, Rugit was persisted to a file.
- Docs: assistant.md, cli-and-mcp.md, plus a troubleshooting.md row.
