---
# pkm-d8vp
title: 'upload_asset: show and constrain the resolved host path'
status: completed
type: task
priority: normal
created_at: 2026-10-23T10:56:19Z
updated_at: 2026-10-24T18:26:27Z
parent: pkm-mfd0
---

Review finding (Low): an approved upload_asset reads any service-account-readable file with an allowed extension, follows symlinks, and resolves relative paths against the server cwd (app/server in production), so ../../data/config.json is the server's secret config. The card shows the path as emitted.

- [x] Red test first, from the review probe: sec-assistant/probe_upload.py. Probes live in docs/superpowers/handoffs/security-review-2026-10-23-probes (main checkout, gitignored; README maps probes)
- [x] Decide containment (Arthur, 2026-10-24): remove upload_asset from the in-app assistant entirely; keep it in pkm-mcp
- [x] Assistant: drop upload_asset from WRITE_TOOLS / WRITE_PREVIEW_FIELDS / the system prompt's write-verb list (pkm.assistant.policy), so the assistant's MCP allow-list never offers it; a test that the assistant's tool list excludes it and that a call to it is denied
- [x] Docs: the assistant section says the assistant cannot read host files, and why

## Decision (Arthur, 2026-10-24)

Uploads never happen from the assistant: it has no way to obtain files. So the assistant loses the tool rather than gaining a containment root. pkm-mcp keeps upload_asset unchanged: there it runs as the user in their own agent session (path relative to that session's cwd), so reading the user's files is the point and no privilege boundary is crossed. The resolved-path card and relative-path rules are moot once the assistant cannot call it. The red test still comes from sec-assistant/probe_upload.py: through the assistant, ../../data/config.json must be refused (tool not offered/denied).

## Summary of Changes

- The assistant starts `pkm.mcp.server --tools` with the names in `READ_TOOLS` + `WRITE_TOOLS`, so `upload_asset` is never registered in its subprocess (`build_server`, `main(argv)`; an unknown or empty name fails the start).
- `upload_asset` left `WRITE_TOOLS`, `WRITE_PREVIEW_FIELDS` and the system prompt; `MCP_ONLY_TOOLS` names it with the reason. `can_use_tool` denies a call to it with no card (red test with the probe's `../../data/config.json`).
- Found in review: the harness also loaded the account's claude.ai MCP connectors (Google Docs, Atlassian, ...); `strict_mcp_config=True` now loads only `pkm` (confirmed with a live harness probe).
- The preview parity test now requires an input for every write tool.
- pkm-mcp's `upload_asset` is unchanged. Docs: assistant.md (Tool surface, Harness confinement), cli-and-mcp.md, two troubleshooting rows. The SECURITY.md wording went to pkm-e95y.
- Gates: pytest 4816 passed, pyrefly 0, ruff 0; perf backend and frontend unchanged.
