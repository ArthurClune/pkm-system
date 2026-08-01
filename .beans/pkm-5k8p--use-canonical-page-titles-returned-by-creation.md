---
# pkm-5k8p
title: Use canonical page titles returned by creation
status: todo
type: bug
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 22).

## Context

**References:** `server/src/pkm/cli/main.py:360-367`; `server/src/pkm/mcp/server.py:38-46`; `server/src/pkm/client/api.py:126-127`; `server/src/pkm/server/routes_pages.py:193-203`

Both _ensure_page() implementations ignore the canonical title returned by POST and refetch the original spelling. Leading/trailing or control whitespace can create the normalized page and then 404 on refetch, leaving side effects after a failed command.

Note: the high-priority sweep (pkm-w80k) removed _ensure_page from both shells and moved page creation into the OpBatch — verify what remains of this finding against current code before implementing; fix whatever canonical-title gap still exists.

**Direction:** Use the returned canonical title and centralize ensure-page behavior.

## Tasks

- [ ] Add whitespace-normalization tests for CLI and MCP
- [ ] Remove duplicate, non-canonical ensure-page implementations
