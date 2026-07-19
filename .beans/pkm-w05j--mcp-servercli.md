---
# pkm-w05j
title: MCP Server/CLI
status: in-progress
type: feature
priority: normal
created_at: 2026-07-14T19:51:14Z
updated_at: 2026-07-19T16:16:56Z
---

We need a MCP server and/or CLI server for LLMs to use

## Design

Approved design: docs/superpowers/specs/2026-07-19-mcp-cli-design.md

Key decisions: HTTP-API-only access; login-once cookie cache; Python inside server pkg; shared `pkm.client` lib with thin `pkm` CLI + `pkm-mcp` (stdio) frontends; scope = roam-CLI parity + upload; two new read-only endpoints (GET /api/block/{uid}, GET /api/todos).

- [ ] Design doc written and committed
- [ ] Implementation plan (writing-plans)
- [ ] Implementation
- [ ] Follow-up bean: .claude/skills/pkm skill doc
