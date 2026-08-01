---
# pkm-3cyg
title: Do not silently truncate CLI/MCP backlinks
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 23).

## Context

**References:** `server/src/pkm/client/api.py:102-105`; `server/src/pkm/cli/main.py:78-81,335-339`; `server/src/pkm/mcp/server.py:80-84`; `server/src/pkm/server/routes_pages.py:165-187`

get_page() requests at most 100 backlink groups while the route is paginated. CLI/MCP render the partial result without a truncation marker despite CLI wording that promises every block.

**Direction:** Fetch all pages or expose pagination and clearly report truncation through a dedicated client method. (Arthur's standing preference: no silent truncation.)

## Tasks

- [ ] Test total_pages > len(groups) in client, CLI, and MCP
- [ ] Make completeness/truncation explicit
