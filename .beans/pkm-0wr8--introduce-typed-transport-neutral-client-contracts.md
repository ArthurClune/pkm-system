---
# pkm-0wr8
title: Introduce typed transport-neutral client contracts and remove dependency inversion
status: todo
type: task
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 20).

## Context

**References:** `server/src/pkm/client/api.py:18,91-148`; `server/src/pkm/cli/build.py:10,38-342`; `server/src/pkm/server/response_models.py:18-264`; imports in `server/src/pkm/cli/main.py:27-28` and `server/src/pkm/mcp/server.py:19`

PkmClient returns bare dictionaries and downstream planners/renderers access nested untyped data, so static checking cannot catch response drift despite exact Pydantic models existing. CLI/MCP depend inward on pkm.server.* and duplicate ensure-page/default-date/fetch-plan-post workflows.

**Direction:** Move transport-neutral operation/response contracts into an independent domain package, return validated models or precise TypedDicts, and extract shared application workflows while keeping presentation shells separate.

## Tasks

- [ ] Define dependency direction and transport-neutral contracts
- [ ] Add malformed/stale response contract tests
- [ ] Replace duplicate CLI/MCP workflows without over-generalising presentation
