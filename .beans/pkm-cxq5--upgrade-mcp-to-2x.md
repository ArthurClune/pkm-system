---
# pkm-cxq5
title: Upgrade mcp to 2.x
status: todo
type: task
priority: low
created_at: 2026-10-29T18:02:40Z
updated_at: 2026-10-29T18:02:40Z
---

The oirq branch held mcp at `>=1.30,<2` (1.30.0 carries the advisory fixes). mcp 2.x is a new major: it drops httpx and pydantic-settings as dependencies and adds mcp-types. pkm-mcp and the assistant's stdio MCP config need checking against it.

- [ ] Read the 2.x migration notes
- [ ] Check pkm-mcp's server API usage against 2.x
- [ ] Check the assistant's stdio config and the harness spawn against 2.x
- [ ] Lift the <2 bound, uv lock, pip-audit clean
- [ ] Server gates green
