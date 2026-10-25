---
# pkm-0214
title: Assistant panel shows a refused or failed write itself
status: completed
type: feature
priority: low
created_at: 2026-10-25T17:04:04Z
updated_at: 2026-10-25T19:07:30Z
parent: pkm-mfd0
---

From the pkm-6fcv plan (2026-10-25). When an allowed write is refused (412: the block changed since the card showed it) or any tool call errors, the user learns of it only through the model's reply; a prompt-injected model could claim the write succeeded. Question for Arthur: should the panel itself show the refusal/error under the tool call?

- [x] Arthur: show tool errors in the panel, or leave it to the model's reply — Arthur 2026-10-25: yes, the panel shows the refusal
- [x] The panel shows a refused allowed write (412) and other write-tool errors under the tool call, independent of the model's reply
- [x] troubleshooting/assistant.md updated

## Summary of Changes

The server reads each write tool's result error flag (ToolResultBlock.is_error, set from the MCP tool's isError, never from the model) and emits ToolFinished(tool_use_id, name, error, declined); the reason is the tool's text with the CLI wrapper, FastMCP prefix and HTTP status dropped, clipped at 300. A decline is known from the server's own card answer. The web pairs tool lines by id across turns and shows ✗ + "Failed: <reason>" (React text in <bdi dir=ltr>) or "Declined" (no glyph); read-tool errors are unmarked. E2E: a refused Allow under a model reply that claims success shows the ✗ and the reason. Live harness check: the event read "block ((…)) changed after the approval card showed it, so nothing was written". Follow-up: pkm-* partial-batch ✓ (filed).
