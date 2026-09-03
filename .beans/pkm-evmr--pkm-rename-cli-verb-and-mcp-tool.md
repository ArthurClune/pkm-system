---
# pkm-evmr
title: pkm rename CLI verb and MCP tool
status: completed
type: feature
priority: normal
created_at: 2026-09-03T13:01:14Z
updated_at: 2026-09-03T13:15:09Z
---

Add a `pkm rename` CLI verb and a matching `rename_page` MCP write tool, both thin wrappers over the existing `POST /api/page/{title}/rename` endpoint, so page renames can be scripted rather than done one at a time in the web UI. Motivation: moving ~31 LLM-related pages into an `LLM/` title namespace.

## Interface

- CLI: `pkm rename "Old Title" "New Title" [--allow-merge] [--json]`
  - prints `renamed "Old" -> "New"` or `merged "Old" into "New"` (server-normalised title)
  - 409 collision without `--allow-merge`: exit 1, server message plus a hint to pass `--allow-merge`
  - other errors (404/422/400) flow through the existing friendly-error path
- Client: `PkmClient.rename_page(title, new_title, allow_merge=False) -> RenamePageResponse` (existing contract)
- MCP: `rename_page(title, new_title, allow_merge=False)` write tool; added to `assistant/policy.py` WRITE_TOOLS

## Checklist

- [x] client `rename_page()` + tests (renamed, merged, 409 without merge)
- [x] CLI `rename` verb + tests (success line, --allow-merge, 409 hint, help self-sufficiency)
- [x] MCP `rename_page` tool + policy WRITE_TOOLS + tests
- [x] docs: docs/cli.md command reference; .claude/skills/pkm/SKILL.md write verbs; docs/architecture/cli-and-mcp.md MCP tool table and any tool count
- [x] pytest + pyrefly + ruff green (1642 passed, 97.32% coverage; pyrefly 0 errors; ruff clean)
- [x] whole-branch review (opus; one fix commit)
- [x] merge --no-ff to main

## Summary of Changes

- `PkmClient.rename_page()` wraps `POST /api/page/{title}/rename`, quoting the title like `get_page`.
- `pkm rename OLD NEW [--allow-merge] [--json]` prints one line (`renamed ... -> ...` or `merged ... into ...`); a 409 without the flag exits 1 with the server message and a hint.
- `rename_page` MCP write tool; added to the assistant policy's WRITE_TOOLS and to the assistant SYSTEM_PROMPT's verb list (which had gone stale), with a tripwire test that every write tool is named in the prompt.
- Tests cover renamed/merged/409, `LLM/`-style slash titles and `?` titles round-tripping through the URL path, help self-sufficiency, MCP tool registration and policy classification.
- Docs: docs/cli.md, pkm skill, cli-and-mcp.md tool table; MCP tool count corrected to twelve (five write) in README, SECURITY.md, overview.md, assistant-and-files.md, design.md.

Pre-existing endpoint quirks noted by review, not fixed here: the rename route does not canonicalize padded path titles, and the daily-note guard checks only the source title so a page can be renamed *into* a date-shaped title.
