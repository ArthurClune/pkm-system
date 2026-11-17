---
# pkm-cxq5
title: Upgrade mcp to 2.x
status: completed
type: task
priority: low
created_at: 2026-10-29T18:02:40Z
updated_at: 2026-11-17T20:47:10Z
---

The oirq branch held mcp at `>=1.30,<2` (1.30.0 carries the advisory fixes). mcp 2.x is a new major: it drops httpx and pydantic-settings as dependencies and adds mcp-types. pkm-mcp and the assistant's stdio MCP config need checking against it.

- [x] Read the 2.x migration notes
- [x] Check pkm-mcp's server API usage against 2.x
- [x] Check the assistant's stdio config and the harness spawn against 2.x
- [x] Lift the <2 bound, uv lock, pip-audit clean
- [x] Server gates green


## Reasons for Scrapping

mcp 1.30 already carries the advisory fixes, and nothing here needs 2.x. A major upgrade touching pkm-mcp and the assistant's stdio config is risk with no payoff today. A future 1.x advisory would surface in an audit and is the reason to revisit. (Arthur, 2026-11-11.)

## Reopened

Arthur, 2026-11-17: do it alongside the server dependency refresh (pkm-hujh) rather than wait for an advisory.

mcp 2.3.0 findings from the migration guide and the installed package: `mcp.server.fastmcp` is gone (`FastMCP` is `mcp.server.mcpserver.MCPServer`; `func_metadata` and `FuncMetadata` move to `mcp.server.mcpserver.utilities.func_metadata` with v1 shapes). Plain `def` tools now run on a worker thread, so parallel calls from one client run concurrently. While serving stdio, fd 0 is /dev/null and fd 1 is stderr. Client-side result fields are snake_case (`is_error`, `structured_content`). `MCP_*` environment settings are no longer read. opentelemetry-api becomes a dependency (no provider is configured, so it is a no-op).

- [x] Port pkm-mcp, write_preview and the test runner to the 2.x module paths
- [x] Check concurrent tool calls against pkm-mcp's module state
- [x] Client-side test field renames
- [x] Docs naming FastMCP

## Summary of Changes

mcp 1.30 to 2.3. pkm-mcp builds an `MCPServer` (FastMCP's new name); write_preview and the test runner import `func_metadata` from `mcp.server.mcpserver.utilities`; client-side tests read `is_error`, `structured_content` and `output_schema`.

mcp 2 shows the model only `Error executing tool <name>` for any exception but `ToolError`, which would have hidden every refusal and server rejection (`update_block: no expect argument`, `404: page not found`). `build_server()` registers each tool through `_reported`, which re-raises with the same text as a `ToolError`; the model sees what it saw under 1.x. Without it, `test_assistant_mcp_server_refuses_a_guarded_write_without_expect`, `test_update_block_expect_through_mcpserver` and `test_a_tool_error_keeps_its_text_for_the_model` fail. `_reported` refuses an `async def` tool, which it would otherwise register to return a coroutine.

Sync tools now run on worker threads, so a client's parallel calls run at once. pkm-mcp's module state is set before `run()` and only read after, and `PkmClient` holds no mutable state; a live turn ran two `get_page` calls in parallel.

mcp 2 drops httpx, which eight test files imported without declaring; they use the declared httpx2. pip-audit is clean. A live sonnet turn on a scratch server read a page and quoted a failed read's full error text. docs/architecture/cli-and-mcp.md states the `_reported` and threading rules.
