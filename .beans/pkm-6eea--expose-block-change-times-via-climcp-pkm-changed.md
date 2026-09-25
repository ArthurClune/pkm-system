---
# pkm-6eea
title: Expose block change times via CLI/MCP (pkm changed)
status: in-progress
type: feature
created_at: 2026-09-25T09:02:02Z
updated_at: 2026-09-25T09:02:02Z
---

The assistant reaches PKM through the CLI/MCP, but nothing there exposes block edit times, so it cannot answer "what blocks did I add or update yesterday?".

Design (approved 2026-09-25, option A: `updated_at` as-is, so moves/renames count as edits):
- `GET /api/changed?since&until&page&limit`: blocks whose updated_at is in [since, until), grouped by page in chronological order; each item carries created_at, updated_at, status new|edited; total always reported.
- since/until: date (local midnight) or ISO datetime; until exclusive, defaults to now; bad input -> 400.
- Pure window parsing/classification in a Functional Core module; the route does only the SQL.
- `PkmClient.changed`, `pkm changed [today|yesterday|YYYY-MM-DD] [--since --until] [-p] [--limit] [--json]`, MCP `changed_blocks`.
- Limits documented: latest edit time only, deletions invisible, moves/renames count.

## Checklist
- [x] Core module + tests
- [x] Route + endpoint tests
- [x] Client, CLI, MCP + tests
- [x] openapi.json + gen-types
- [x] Docs: backend.md, cli-and-mcp.md, pkm skill
- [x] pytest, pyrefly, ruff green
