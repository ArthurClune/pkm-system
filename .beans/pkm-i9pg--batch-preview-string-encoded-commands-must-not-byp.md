---
# pkm-i9pg
title: 'Batch preview: string-encoded commands must not bypass the per-op listing'
status: todo
type: bug
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T11:49:58Z
parent: pkm-mfd0
---

Review finding (Medium; Low after the fact-finding below): ops_preview only lists ops when batch.commands is a list. A JSON string falls through to the generic clipped dump (no op count; trailing commands invisible), then FastMCP pre_parse_json turns it back into a list and apply_batch runs all of it.

- [ ] Red test first, from the review probe: sec-assistant/probe_preview.py (string-encoded commands). Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [x] First establish whether the Claude CLI validates MCP input against inputSchema before can_use_tool (if it does, this is defence in depth)
- [ ] Preview the input exactly as the tool will receive it (same pre-parse), or deny a write whose input is not schema-shaped
- [ ] Test with the payload from the review report

## Fact-finding: does the CLI pass a string-encoded `commands` through? (2026-10-23)

Bundled CLI: claude_agent_sdk/_bundled/claude, `--version` 2.1.301 (Claude Code).
Read from the binary's embedded JS (minified names, so tied to this build):

- When it assembles a tool_use input from the stream, the CLI calls a
  normaliser (`Qge(tool, input)`, then `IRt(...)`) on any object input before
  the tool runs. For each top-level property whose JSON-schema type is
  array/object/boolean/integer/number (resolved through $ref/anyOf/oneOf), a
  string value that JSON-parses to that type is replaced by the parsed value.
  The same function is used, with `logRepairs:false`, in a "wire tool input
  consistency check".
- pkm's MCP `batch` inputSchema declares `commands` as `type: array`.
- So a model that emits `commands` as a JSON string has it turned back into
  a list before `can_use_tool`, and `ops_preview` sees a list. The string
  path that the review reproduced (calling `ops_preview` directly) does not
  arise through this CLI build.
- No real model turn was sent; this is a reading of the code, not an
  observation of a live call. A future CLI could drop the repair, so the fix
  stays, as defence in depth: preview what the tool will receive
  (same pre-parse as FastMCP) or deny a write whose input is not schema-shaped.
- Severity: Medium -> Low (defence in depth).
