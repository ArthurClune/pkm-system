---
# pkm-4w23
title: Validate batch commands with a discriminated schema before planning or I/O
status: todo
type: task
priority: normal
created_at: 2026-08-01T07:51:42Z
updated_at: 2026-08-01T07:51:42Z
parent: pkm-ulae
---

Part of the pkm-ulae medium-priority sweep (finding 21).

## Context

**References:** `server/src/pkm/cli/build.py:296-320,341-414`; `server/src/pkm/cli/main.py:420-432,561-572`; `server/src/pkm/mcp/server.py:134-149`

The only contract is list[dict]; malformed items and nested values can escape as AttributeError/KeyError. plan_batch() is also an oversized dispatcher combining validation, alias state, and planning.

**Direction:** Add command-specific discriminated models in the functional core, validate the full envelope before page discovery, and dispatch to small per-command planners with one stable user-facing error contract.

## Tasks

- [ ] Test non-object items/params, missing/wrong fields, indexes, and aliases in CLI and MCP
- [ ] Split validation from command planning
