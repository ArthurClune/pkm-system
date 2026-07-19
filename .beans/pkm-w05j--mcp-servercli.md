---
# pkm-w05j
title: MCP Server/CLI
status: in-progress
type: feature
priority: normal
created_at: 2026-07-14T19:51:14Z
updated_at: 2026-07-19T17:50:20Z
---

We need a MCP server and/or CLI server for LLMs to use

## Design

Approved design: docs/superpowers/specs/2026-07-19-mcp-cli-design.md

Key decisions: HTTP-API-only access; login-once cookie cache; Python inside server pkg; shared `pkm.client` lib with thin `pkm` CLI + `pkm-mcp` (stdio) frontends; scope = roam-CLI parity + upload; two new read-only endpoints (GET /api/block/{uid}, GET /api/todos).

- [x] Design doc written and committed
- [x] Implementation plan (writing-plans)
- [x] Implementation
- [ ] Follow-up bean: .claude/skills/pkm skill doc


## Summary of Changes

Shipped a shared HTTP-API client plus two frontends for LLM/human access to
the PKM graph, with no new server state beyond two read endpoints:

- `pkm.client` (`core` + `api`): thin typed wrapper over the existing HTTP
  API, handling login, session-cookie persistence
  (`~/.config/pkm-cli/config.json`, overridable via `PKM_CLI_CONFIG`), and
  pure request/response shaping (outline building, parent resolution,
  batch-op planning) kept separate from the I/O shell per FCIS.
- `pkm` CLI (`pkm.cli`: `render`/`build`/`main`) with 10 subcommands —
  `login`, `get` (page/today/uid, markdown or `--json`/`--uids`), `search`,
  `refs`, `query`, `todos`, `save` (incl. outline-via-stdin and
  `--parent`/`--todo`), `update` (text/done/todo-toggle), `upload`, and
  `batch` (atomic multi-op transactions from a JSON array on stdin).
- `pkm.mcp.server`: stdio MCP server exposing the same 10 operations as MCP
  tools for Claude Code / Claude Desktop.
- Two new read-only endpoints: `GET /api/block/{uid}` and `GET /api/todos`
  (backing `pkm get <uid>` and `pkm todos`), plus the corresponding
  regenerated OpenAPI schema/TS types.
- Console scripts `pkm` and `pkm-mcp` registered in `server/pyproject.toml`.
- README: new "CLI and MCP access" section with login, CLI quick reference,
  and MCP setup (`claude mcp add` / `.mcp.json` / Claude Desktop config).

Verified end-to-end with a manual smoke test against a throwaway dev server
(port 8985, `/tmp/pkm-smoke`): `pkm login --password-stdin`, `pkm save
--todo`, `pkm todos`, and `pkm get today --uids` all round-tripped correctly.

Follow-up skill-doc bean (`.claude/skills/pkm`) is intentionally left open —
offering to create it separately.
