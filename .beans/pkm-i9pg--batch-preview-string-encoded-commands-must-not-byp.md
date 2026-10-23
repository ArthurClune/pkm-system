---
# pkm-i9pg
title: 'Batch preview: string-encoded commands must not bypass the per-op listing'
status: todo
type: bug
priority: high
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-23T10:56:19Z
parent: pkm-mfd0
---

Review finding (Medium): ops_preview only lists ops when batch.commands is a list. A JSON string falls through to the generic clipped dump (no op count; trailing commands invisible), then FastMCP pre_parse_json turns it back into a list and apply_batch runs all of it.

- [ ] Red test first, from the review probe: sec-assistant/probe_preview.py (string-encoded commands). Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [ ] First establish whether the Claude CLI validates MCP input against inputSchema before can_use_tool (if it does, this is defence in depth)
- [ ] Preview the input exactly as the tool will receive it (same pre-parse), or deny a write whose input is not schema-shaped
- [ ] Test with the payload from the review report
